import { DurableObject } from "cloudflare:workers";
import {
  clientMessageSchema,
  CLOSE_BAD_TICKET,
  CLOSE_KICKED,
  CLOSE_PROTOCOL_VIOLATION,
  LIMITS,
  MemberInit,
  Sound,
  UserProfile,
} from "@tavern/shared";
import type { ClientMessage, ErrorCode } from "@tavern/shared";
import { z } from "zod";
import { migrate } from "./sql";
import { RoomState, rtcAuthorizeReqSchema } from "./roomState";
import type { ConnAttachment, RoomMeta, RtcAuthorizeRes } from "./roomState";
import { ChatModule } from "./chat";
import { ActivityModule } from "./activity";
import { StatsModule } from "./stats";
import { CostMeter } from "./costMeter";
import { RecordingsModule } from "./recordings";
import {
  createSound,
  deleteSound,
  listSounds,
  patchSound,
  recordPlay,
  soundExists,
  TavernError,
} from "./soundboard";
import type { Actor, SoundPatch } from "./soundboard";

// Internal recording route bodies (Worker → DO). The Worker route resolves the caller's userId + admin
// from the session; the DO decides authorization from its own registry (§7.4).
const recOpenBody = z.object({ userId: z.string() });
const recResolveBody = z.object({ userId: z.string(), recordingId: z.string() });
const recFinalizeBody = z.object({ recordingId: z.string(), durationMs: z.number() });
const recAbortBody = z.object({ userId: z.string(), recordingId: z.string() });
const recDeleteBody = z.object({
  userId: z.string(),
  isAdmin: z.boolean(),
  recordingId: z.string(),
});

// The `sound.updated` broadcast fires after every create/patch/delete; clients refetch the list (S9.2).
// The create body carries the not-yet-persisted sound (playCount is derived, so omitted) + its R2 key.
const createSoundBody = z.object({ sound: Sound.omit({ playCount: true }), r2Key: z.string() });
const patchSoundBody = z.object({
  soundId: z.string(),
  patch: z.object({
    name: z.string().optional(),
    trimStartMs: z.number().optional(),
    trimEndMs: z.number().optional(),
  }),
  actor: z.object({ userId: z.string(), isAdmin: z.boolean() }),
});
const deleteSoundBody = z.object({
  soundId: z.string(),
  actor: z.object({ userId: z.string(), isAdmin: z.boolean() }),
});

// TavernError code → the HTTP status the Worker route forwards for a soundboard op.
function soundErrorStatus(code: ErrorCode): 403 | 404 | 422 {
  if (code === "forbidden") return 403;
  if (code === "not_found") return 404;
  return 422; // bad_trim
}

// The Worker sets this header on EVERY DO stub call; the DO has no other ingress path, so a missing
// header on an /internal/* route means the request did not originate from the Worker → 403.
const INTERNAL_HEADER = "X-Tavern-Internal";

// The empty-voice alarm interval (ghost lifetime ≤ this = the FR-24 crash-safety close). 5 s in tests
// that opt in via the env flag (set only in .dev.vars / test env, never production config — §S3.4 task 5).
const FAST_ALARM_MS = 5_000;

// Minimum gap between accepted `sound.play` frames from one user (FR-36 rate limit, §App-B
// rateSoundPlayPerSec = 1/s → 1000 ms). Token bucket of capacity 1 = a per-user last-accepted stamp.
const SOUND_PLAY_MIN_GAP_MS = 1000 / LIMITS.rateSoundPlayPerSec;

// Streamer userId encoded in a watchable video track name (§7.1 grammar `screen:{uid}:{n}` /
// `cam:{uid}`). Used to key the watch-stat (viewer→streamer) pair on watch.stop, when the stream may
// already be gone from the registry (the streamer stopped first) — the name still carries the owner.
function streamerIdOf(trackName: string): string | null {
  const parts = trackName.split(":");
  if (parts[0] === "screen" && parts.length === 3) return parts[1] ?? null;
  if (parts[0] === "cam" && parts.length === 2) return parts[1] ?? null;
  return null;
}

declare global {
  // Test-only flag: '1' shortens the voice alarm interval to 5 s. Optional — absent in production.
  interface Env {
    TAVERN_TEST_FAST_ALARM?: string;
  }
}

// The per-server Durable Object: WebSocket lifecycle + internal-route dispatch + message router ONLY.
// All state logic lives in RoomState; all schema/migration in sql.ts.
export class ServerRoom extends DurableObject<Env> {
  private readonly room: RoomState;
  // One ChatModule per DO → its rate-limit buckets are per-server (§S3.2 task 3).
  private readonly chat: ChatModule;
  // One ActivityModule per DO → the append-and-broadcast producer for every event (§S3.3). Voice
  // producers (voice.join/voice.leave) are wired here in S3.4; stream/recording producers in S8/S9.
  private readonly activity: ActivityModule;
  // One StatsModule per DO → server-authoritative watch/stream accumulators (FR-40). Fed by the voice
  // leave/alarm sweep now; S8.4 feeds it stream/watch start/stop.
  private readonly stats: StatsModule;
  // One CostMeter per DO → §8 G5 egress estimate + kill switch. Ticked on the 60s alarm, reprices on
  // layer, gates non-mic pulls at the cap; snapshotted into hello.ok.costStatus.
  private readonly costMeter: CostMeter;
  // One RecordingsModule per DO → the single active-recording state machine (FR-25). Fed by the
  // rec.start/rec.stop router + the disconnect/leave dirty-end path; the Worker multipart routes reach
  // it via /internal/recordings/*. Broadcasts + activity go through `room`/`activity`.
  private readonly recordings: RecordingsModule;
  // connId → hello-timeout handle (in-memory; a 5 s pending timer keeps the DO from hibernating, so
  // the same instance handles the hello within the window — negligible cost, §S3.1 task 6).
  private readonly helloTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // userId → recent upload timestamps (sliding window, §S9.1 task 4). In-memory like the chat bucket:
  // a DO eviction only ever REFILLS a user's upload budget (never revokes) — acceptable at our scale.
  private readonly uploadTimes = new Map<string, number[]>();
  // userId → last accepted sound.play timestamp (FR-36 per-user rate limit; in-memory per DO like the
  // upload/chat buckets — a DO eviction only ever refills the budget, never revokes, fine at our scale).
  private readonly soundPlayTimes = new Map<string, number>();
  // The message router later steps plug domain modules into. This step implements `hello`; every
  // other valid type answers `not_implemented` until S3.2/S3.4/S8/S9 fill the map (S12.4 verifies none
  // remain). `ping` never reaches here — setWebSocketAutoResponse answers it without waking the DO.
  private readonly routes: Record<
    ClientMessage["t"],
    (ws: WebSocket, att: ConnAttachment, msg: ClientMessage) => void | Promise<void>
  >;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.room = new RoomState(ctx, env);
    this.chat = new ChatModule(ctx.storage.sql);
    this.activity = new ActivityModule(ctx.storage.sql);
    this.stats = new StatsModule(ctx);
    this.costMeter = new CostMeter(ctx, env);
    this.recordings = new RecordingsModule({
      sql: ctx.storage.sql,
      storage: ctx.storage,
      media: env.MEDIA,
      room: this.room,
      activity: this.activity,
    });
    this.routes = {
      hello: (ws, att) => this.handleHello(ws, att),
      "chat.send": (ws, att, msg) => this.handleChatSend(ws, att, msg),
      "chat.history": (ws, att, msg) => this.handleChatHistory(ws, att, msg),
      "voice.join": (ws, att) => this.handleVoiceJoin(ws, att),
      "voice.leave": (_ws, att) => this.leaveVoice(att.userId, Date.now()),
      "voice.state": (ws, att, msg) => this.handleVoiceState(ws, att, msg),
      "stream.start": (_ws, att) => this.handleStreamStart(att),
      "stream.preset": (ws, att, msg) => this.handleStreamPreset(ws, att, msg),
      "stream.stop": (_ws, att, msg) => this.handleStreamStop(att, msg),
      "watch.start": (ws, att, msg) => this.handleWatchStart(ws, att, msg),
      "watch.stop": (_ws, att, msg) => this.handleWatchStop(att, msg),
      "sound.play": (ws, att, msg) => this.handleSoundPlay(ws, att, msg),
      "rec.start": (ws, att) => this.handleRecStart(ws, att),
      "rec.stop": (ws, att) => this.handleRecStop(ws, att),
      ping: (ws) => this.notImplemented(ws),
    };
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql);
      await this.room.load();
      await this.recordings.load();
    });
    // Protocol pings answered without waking the DO (App-A `ping`/`pong`).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The Worker forwards the upgrade Request unchanged (preserving WS semantics), so the path is
    // the client's `/api/servers/:id/ws`; direct DO-stub tests use `/ws`. Both end in `/ws`.
    if (url.pathname.endsWith("/ws")) return this.handleUpgrade(request, url);
    if (url.pathname.startsWith("/internal/")) {
      if (request.headers.get(INTERNAL_HEADER) !== "1") {
        return Response.json({ error: "forbidden" satisfies ErrorCode }, { status: 403 });
      }
      return this.handleInternal(request, url);
    }
    return Response.json({ error: "not_implemented" satisfies ErrorCode }, { status: 501 });
  }

  // GET /ws?ticket=… — consume the one-time ticket, accept the hibernatable socket, arm the hello
  // timeout. An invalid ticket accepts then closes 4002 so the client can re-ticket (a plain 403
  // gives browsers an opaque error).
  private async handleUpgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "bad_request" satisfies ErrorCode }, { status: 426 });
    }
    const ticket = url.searchParams.get("ticket");
    const userId = ticket === null ? null : await this.room.consumeTicket(ticket);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    if (userId === null) {
      server.close(CLOSE_BAD_TICKET, "ticket");
      return new Response(null, { status: 101, webSocket: client });
    }

    const attachment: ConnAttachment = { userId, connId: crypto.randomUUID(), hello: false };
    server.serializeAttachment(attachment);
    const timer = setTimeout(() => {
      const att: ConnAttachment | null = server.deserializeAttachment();
      if (att !== null && !att.hello) server.close(CLOSE_PROTOCOL_VIOLATION, "hello timeout");
      this.helloTimers.delete(attachment.connId);
    }, LIMITS.helloTimeoutMs);
    this.helloTimers.set(attachment.connId, timer);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Worker-only ingress (header-guarded by fetch). Each route is a Worker→DO plumbing call.
  private async handleInternal(request: Request, url: URL): Promise<Response> {
    const at = Date.now();
    switch (url.pathname) {
      case "/internal/ticket": {
        const body: { userId: string } = await request.json();
        return Response.json({ ticket: await this.room.createTicket(body.userId) });
      }
      case "/internal/member-join": {
        const body: { member: unknown; serverMeta: RoomMeta } = await request.json();
        const member = MemberInit.parse(body.member);
        this.room.upsertMember(member);
        await this.room.setMeta(body.serverMeta);
        this.room.broadcast({
          t: "member.joined",
          member: { ...member, presence: this.room.presenceOf(member.userId) },
          at,
        });
        // FR-39 producer: a genuinely new membership (the join route skips this call for a re-join, so
        // one entry per join) → append `member.join` and broadcast `activity.new` to live UIs.
        this.room.broadcast({
          t: "activity.new",
          entry: this.activity.append("member.join", member.userId, {}, at),
        });
        return new Response(null, { status: 204 });
      }
      case "/internal/member-update": {
        const body: { profile: unknown } = await request.json();
        const profile = UserProfile.parse(body.profile);
        this.room.updateProfile(profile);
        this.room.broadcast({ t: "member.update", profile, at });
        return new Response(null, { status: 204 });
      }
      // FR-11 kick (S2.2): body `{ userId, by }` (`by` = the acting admin). Order is pinned. (1) Evict
      // every socket of the user — a `kicked` frame then close 4001 — so their UI returns to the join
      // screen. (2) Drop the member cache + broadcast `member.left`. (3) Broadcast `presence.update
      // offline` (the frame remaining members assert — the kicked user is gone). (4) Append the
      // `member.kick` activity (meta carries `by`) + broadcast `activity.new`. The kicked user's own
      // sockets are excluded from every survivor broadcast (they are closing). Response `200 { closed }`.
      case "/internal/kick": {
        const body: { userId: string; by: string } = await request.json();
        const kickedSockets = this.room.socketsOf(body.userId);
        for (const ws of kickedSockets) {
          this.room.send(ws, { t: "kicked", at });
          ws.close(CLOSE_KICKED, "kicked");
        }
        this.room.removeMember(body.userId);
        this.room.broadcast(
          { t: "member.left", userId: body.userId, at },
          { except: kickedSockets },
        );
        this.room.broadcast(
          { t: "presence.update", userId: body.userId, presence: "offline", at },
          { except: kickedSockets },
        );
        this.room.broadcast(
          {
            t: "activity.new",
            entry: this.activity.append("member.kick", body.userId, { by: body.by }, at),
          },
          { except: kickedSockets },
        );
        return Response.json({ closed: kickedSockets.length });
      }
      // FR-12 rename (S2.2): update the DO's cached `serverMeta.nickname`, then broadcast `server.updated`
      // to every live socket. Response is `200 { ok: true }`.
      case "/internal/server-updated": {
        const body: { nickname: string } = await request.json();
        await this.room.patchNickname(body.nickname);
        this.room.broadcast({ t: "server.updated", nickname: body.nickname, at });
        return Response.json({ ok: true });
      }
      // GET /internal/activity?before&limit → { entries, hasMore } (§6.1). The Worker route validates
      // and forwards clean numeric params; a missing `limit` defaults to the page size (page() clamps).
      case "/internal/activity": {
        const before = url.searchParams.get("before");
        const limit = url.searchParams.get("limit");
        const page = this.activity.page({
          ...(before === null ? {} : { before: Number(before) }),
          limit: limit === null ? LIMITS.historyPageSize : Number(limit),
        });
        return Response.json(page);
      }
      // POST /internal/rtc/authorize (§6.1) — the SOLE authority on voice membership (G1), the
      // share cap (G4), pull grants + the egress kill (G5). The Worker route builds the op from the
      // client body (deriving `kind` from the track-name grammar); the DO decides + registers.
      case "/internal/rtc/authorize": {
        const parsed = rtcAuthorizeReqSchema.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json({ ok: false, error: "bad_request" } satisfies RtcAuthorizeRes);
        }
        const res = await this.room.rtcAuthorize(parsed.data, this.costMeter, at);
        return Response.json(res);
      }
      // GET /internal/stats → StatsResponse (§6.1 `GET /api/servers/:id/stats`). perUser unions the
      // member cache + message senders + stream-seconds rows; messages from ChatModule.
      case "/internal/stats": {
        const snapshot = this.stats.snapshot(
          this.chat.messageCountByUser(),
          this.room.listMembers(),
        );
        return Response.json(snapshot);
      }
      // GET /internal/sounds → { sounds } (§6.1 `GET /api/servers/:id/sounds`), ordered playCount DESC
      // then createdAt DESC (FR-37). The Worker route validates against the shared SoundsResponse.
      case "/internal/sounds":
        return Response.json({ sounds: listSounds(this.ctx.storage.sql) });
      // POST /internal/sounds/create (FR-34): rate-limit the uploader (§App-B uploadsPerUserPerHour),
      // then persist + broadcast `sound.updated`. On a rate-limit reject the Worker deletes the R2
      // object it already put (task 4). A bad_trim (sub-200ms clip) is likewise a non-2xx the route
      // treats as a failed create (R2 deleted).
      case "/internal/sounds/create": {
        const body = createSoundBody.parse(await request.json());
        if (!this.allowUpload(body.sound.uploaderId, at)) {
          return Response.json({ error: "rate_limited" satisfies ErrorCode }, { status: 429 });
        }
        try {
          const sound = createSound(this.ctx.storage.sql, body.sound, body.r2Key);
          this.recordUpload(body.sound.uploaderId, at);
          this.room.broadcast({ t: "sound.updated", at });
          return Response.json({ sound });
        } catch (err: unknown) {
          if (err instanceof TavernError) {
            return Response.json({ error: err.code }, { status: soundErrorStatus(err.code) });
          }
          throw err;
        }
      }
      // POST /internal/sounds/patch (FR-35): rename / re-trim; uploader-or-admin (actor). Broadcast
      // `sound.updated` on success; map TavernError to the status the route forwards.
      case "/internal/sounds/patch": {
        const body = patchSoundBody.parse(await request.json());
        try {
          const patch: SoundPatch = body.patch;
          const actor: Actor = body.actor;
          const sound = patchSound(this.ctx.storage.sql, body.soundId, patch, actor);
          this.room.broadcast({ t: "sound.updated", at });
          return Response.json({ sound });
        } catch (err: unknown) {
          if (err instanceof TavernError) {
            return Response.json({ error: err.code }, { status: soundErrorStatus(err.code) });
          }
          throw err;
        }
      }
      // POST /internal/sounds/delete (FR-35): uploader-or-admin. Returns the stored R2 key so the
      // Worker deletes the object; broadcasts `sound.updated`.
      case "/internal/sounds/delete": {
        const body = deleteSoundBody.parse(await request.json());
        try {
          const actor: Actor = body.actor;
          const { r2Key } = deleteSound(this.ctx.storage.sql, body.soundId, actor);
          this.room.broadcast({ t: "sound.updated", at });
          return Response.json({ r2Key });
        } catch (err: unknown) {
          if (err instanceof TavernError) {
            return Response.json({ error: err.code }, { status: soundErrorStatus(err.code) });
          }
          throw err;
        }
      }
      // FR-25 recording multipart (§6.1). The Worker routes stream the part bytes + resolve
      // session/admin; the DO owns authorization + the R2 multipart lifecycle (create/abort) + the row.
      // GET /internal/recordings → list (newest finalized first).
      case "/internal/recordings":
        return Response.json({ recordings: this.recordings.list() });
      // POST /internal/recordings/open → create the multipart for the active starter.
      case "/internal/recordings/open": {
        const body = recOpenBody.parse(await request.json());
        return Response.json(await this.recordings.openMultipart(body.userId));
      }
      // POST /internal/recordings/resolve → uploadId + key + startedAt for the PUT part / complete route.
      case "/internal/recordings/resolve": {
        const body = recResolveBody.parse(await request.json());
        return Response.json(this.recordings.resolve(body.userId, body.recordingId));
      }
      // POST /internal/recordings/finalize → stamp ended_at + capped duration, clear upload_id.
      case "/internal/recordings/finalize": {
        const body = recFinalizeBody.parse(await request.json());
        return Response.json(this.recordings.finalize(body.recordingId, body.durationMs));
      }
      // POST /internal/recordings/abort → R2 abort + row delete + inactive broadcast + aborted activity.
      case "/internal/recordings/abort": {
        const body = recAbortBody.parse(await request.json());
        return Response.json(await this.recordings.abort(body.userId, body.recordingId, at));
      }
      // POST /internal/recordings/delete → starter/admin delete of a finalized row; returns its R2 key.
      case "/internal/recordings/delete": {
        const body = recDeleteBody.parse(await request.json());
        return Response.json(this.recordings.remove(body.userId, body.isAdmin, body.recordingId));
      }
      default:
        return Response.json({ error: "not_found" satisfies ErrorCode }, { status: 404 });
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att: ConnAttachment | null = ws.deserializeAttachment();
    if (att === null) {
      ws.close(CLOSE_PROTOCOL_VIOLATION, "no attachment");
      return;
    }
    if (typeof message !== "string") {
      this.rejectFrame(ws);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      this.rejectFrame(ws);
      return;
    }
    const parsed = clientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.rejectFrame(ws);
      return;
    }
    const msg = parsed.data;
    // The first frame MUST be `hello`; any other (even a valid) type before the handshake is fatal.
    if (!att.hello && msg.t !== "hello") {
      this.rejectFrame(ws);
      return;
    }
    await this.routes[msg.t](ws, att, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const att: ConnAttachment | null = ws.deserializeAttachment();
    if (att === null) return;
    const timer = this.helloTimers.get(att.connId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.helloTimers.delete(att.connId);
    }
    const now = Date.now();
    this.room.presenceOnClose(ws, att, now);
    // Implicit voice leave when the user's LAST socket goes away (§S3.4 task 3). Exclude the closing
    // socket; if no other socket for the user remains, they are fully gone → leave voice.
    const otherLive = this.room.socketsOf(att.userId).some((sock) => sock !== ws);
    if (!otherLive) await this.leaveVoice(att.userId, now);
  }

  private handleHello(ws: WebSocket, att: ConnAttachment): void {
    const at = Date.now();
    const firstHello = !att.hello;
    if (firstHello) {
      const next: ConnAttachment = { ...att, hello: true };
      ws.serializeAttachment(next);
      const timer = this.helloTimers.get(att.connId);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.helloTimers.delete(att.connId);
      }
    }
    // Reconnect replays the full snapshot (§6.2 no delta sync); a repeat hello is idempotent.
    this.room.send(
      ws,
      this.room.helloSnapshot(
        att.userId,
        this.chat.lastMessageId(),
        this.costMeter.status(at),
        this.recordings.state(),
      ),
    );
    if (firstHello) this.room.presenceOnHello(ws, att.userId, at);
  }

  // chat.send: validate + rate-limit + extract mentions + persist (ChatModule), then broadcast
  // `chat.new` — the sender's copies carry the echoed nonce, every other socket's copy omits it.
  private handleChatSend(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "chat.send") return;
    const result = this.chat.send({
      userId: att.userId,
      body: msg.body,
      nonce: msg.nonce,
      members: this.room.listMembers(),
      now: Date.now(),
    });
    if (!result.ok) {
      // rate_limited (and the defense-in-depth bad_message) reply on this socket only; it stays open.
      this.room.send(ws, { t: "error", code: result.code });
      return;
    }
    const message = result.message;
    this.room.broadcast({ t: "chat.new", message, nonce: msg.nonce }, { toUserId: att.userId });
    this.room.broadcast({ t: "chat.new", message }, { except: this.room.socketsOf(att.userId) });
  }

  // chat.history: paginated read (ChatModule), replied only to the requesting socket.
  private handleChatHistory(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "chat.history") return;
    const page = this.chat.history({
      ...(msg.beforeId === undefined ? {} : { beforeId: msg.beforeId }),
      limit: msg.limit,
    });
    this.room.send(ws, { t: "chat.page", messages: page.messages, hasMore: page.hasMore });
  }

  // sound.play (FR-36): token-bucket rate-limit the caller (LIMITS.rateSoundPlayPerSec, per user,
  // in-memory per DO) → over-limit `rate_limited`; unknown soundId → `not_found`; else append a
  // `sound_plays` row (FR-37 stats) and broadcast `sound.played` to ALL sockets — the sender included,
  // so it plays on its own broadcast receipt (single code path, tight cross-client sync). Errors reply
  // on the caller's socket only and never consume the rate budget (recorded only on a full success).
  private handleSoundPlay(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "sound.play") return;
    const at = Date.now();
    const last = this.soundPlayTimes.get(att.userId);
    if (last !== undefined && at - last < SOUND_PLAY_MIN_GAP_MS) {
      this.room.send(ws, { t: "error", code: "rate_limited" });
      return;
    }
    if (!soundExists(this.ctx.storage.sql, msg.soundId)) {
      this.room.send(ws, { t: "error", code: "not_found" });
      return;
    }
    this.soundPlayTimes.set(att.userId, at);
    recordPlay(this.ctx.storage.sql, msg.soundId, att.userId, at);
    this.room.broadcast({ t: "sound.played", soundId: msg.soundId, byUserId: att.userId, at });
  }

  // voice.join (FR-18/24): idempotent. A genuinely new join appends the member, opens the session on
  // the first member, appends a `voice.join` activity, broadcasts the full snapshot to ALL sockets
  // (FR-24: non-voice members see the timer), and ensures the crash-safety alarm is armed. A repeat
  // join is a no-op that just re-sends the current snapshot to the requester.
  private async handleVoiceJoin(ws: WebSocket, att: ConnAttachment): Promise<void> {
    const at = Date.now();
    const already = this.room.voiceState().members.some((m) => m.userId === att.userId);
    const snapshot = this.room.voiceJoin(att.userId, at);
    await this.room.persistVoice();
    if (already) {
      this.room.send(ws, { t: "voice.state", voice: snapshot, at });
      return;
    }
    this.room.broadcast({
      t: "activity.new",
      entry: this.activity.append("voice.join", att.userId, {}, at),
    });
    this.room.broadcast({ t: "voice.state", voice: snapshot, at });
    await this.ensureAlarmArmed(at);
  }

  // voice.leave path — shared by the client `voice.leave`, the last-socket disconnect, and the alarm's
  // ghost reconciliation. Idempotent: a user not in voice is a no-op (so a double alarm never double-
  // closes). Closes the leaver's open stream/watch intervals, appends a `voice.leave` activity, and
  // broadcasts the new snapshot to all remaining sockets.
  private async leaveVoice(userId: string, now: number): Promise<void> {
    if (!this.room.voiceState().members.some((m) => m.userId === userId)) return;
    const { snapshot } = this.room.voiceLeave(userId, now);
    await this.room.persistVoice();
    await this.stats.closeAllFor(userId, now);
    // Drop the leaver's SFU sessions/tracks/grants + flush their open meter watches (§S3.4 disconnect
    // cleanup path; the SFU GCs the dead session itself). Broadcasts stream.removed for their video.
    await this.room.rtcCleanupFor(userId, this.costMeter, now);
    // FR-25 dirty end: if the leaver owns the active recording without a prior graceful rec.stop, cancel
    // it (abort R2 multipart, delete row, broadcast inactive, aborted activity). No-op otherwise, so a
    // graceful stop-then-leave or a non-recorder's leave costs nothing.
    await this.recordings.handleUserGone(userId, now);
    this.room.broadcast({
      t: "activity.new",
      entry: this.activity.append("voice.leave", userId, {}, now),
    });
    this.room.broadcast({ t: "voice.state", voice: snapshot, at: now });
  }

  // rec.start (FR-25): the sender must be in voice + no recording active. On success the module inserts
  // the row, flips `rec.state{active}` to everyone, and appends `rec.start`; a rejection replies error
  // on this socket only (it stays open).
  private async handleRecStart(ws: WebSocket, att: ConnAttachment): Promise<void> {
    const code = await this.recordings.start(att.userId, Date.now());
    if (code !== null) this.room.send(ws, { t: "error", code });
  }

  // rec.stop (FR-25, starter only): flips `rec.state{active:false}` immediately + appends `rec.stop`;
  // the row finalizes later via the REST `complete`. A non-starter reply is a socket-local error.
  private async handleRecStop(ws: WebSocket, att: ConnAttachment): Promise<void> {
    const code = await this.recordings.stop(att.userId, Date.now());
    if (code !== null) this.room.send(ws, { t: "error", code });
  }

  // voice.state (FR-26): relay the caller's self mute/deafen flags into the snapshot; broadcast to all.
  private async handleVoiceState(
    ws: WebSocket,
    att: ConnAttachment,
    msg: ClientMessage,
  ): Promise<void> {
    if (msg.t !== "voice.state") return;
    const snapshot = this.room.setVoiceFlags(att.userId, {
      muted: msg.muted,
      deafened: msg.deafened,
    });
    await this.room.persistVoice();
    this.room.broadcast({ t: "voice.state", voice: snapshot, at: Date.now() });
  }

  // stream.start (FR-40): the publisher's "hours streamed" clock opens (server-authoritative). The
  // stream itself was registered + `stream.added`-broadcast on the publish authorize (S7.1 HTTP path);
  // this frame only starts the stat. Idempotent per user — a 2nd concurrent share (webcam alongside a
  // screen, FR-29) does NOT restart the clock, so one clock spans "user is streaming ≥1 thing".
  private async handleStreamStart(att: ConnAttachment): Promise<void> {
    await this.stats.noteStreamStart(att.userId, Date.now());
  }

  // stream.stop (FR-40): close the publisher's stream clock ONLY when they have no OTHER live video
  // track (the registry is the source of truth for active streams). Excluding the track being stopped
  // handles the screen+webcam case (stopping one keeps the clock running while the other streams). The
  // client sends this frame BEFORE the RTC close, so the registry still lists the stopped track here.
  private async handleStreamStop(att: ConnAttachment, msg: ClientMessage): Promise<void> {
    if (msg.t !== "stream.stop") return;
    const now = Date.now();
    const reg = await this.room.rtcSnapshot();
    const otherLiveStream = Object.entries(reg.tracks).some(
      ([name, t]) =>
        t.userId === att.userId &&
        (t.kind === "screen" || t.kind === "cam") &&
        name !== msg.trackName,
    );
    if (!otherLiveStream) await this.stats.noteStreamStop(att.userId, now);
  }

  // watch.start (G1/FR-40): grant the viewer the pull (default low layer, G3), open the cost-meter
  // watch at the stream's CURRENT registry preset (G5), and start the (viewer→streamer) watch-stat
  // clock. No wire ack — the client's pull is authorized against the grant this seeds. An unknown /
  // non-video track → socket-local bad_message (the client reverts to idle on the error frame).
  private async handleWatchStart(
    ws: WebSocket,
    att: ConnAttachment,
    msg: ClientMessage,
  ): Promise<void> {
    if (msg.t !== "watch.start") return;
    const at = Date.now();
    const info = await this.room.rtcWatchable(msg.trackName);
    if (info === null) {
      this.room.send(ws, { t: "error", code: "bad_message" });
      return;
    }
    await this.room.rtcAddGrant(att.userId, msg.trackName, "l");
    await this.costMeter.openWatch(att.userId, msg.trackName, info.preset, "l", at);
    await this.stats.noteWatchStart(att.userId, info.streamerId, at);
  }

  // watch.stop (G1/FR-40): close the cost-meter watch + the watch-stat pair, and release the grant so a
  // later un-watched pull is denied. Idempotent (closing a non-open watch/interval is a no-op). The
  // streamer is derived from the track-name grammar so it works even after the stream was removed.
  private async handleWatchStop(att: ConnAttachment, msg: ClientMessage): Promise<void> {
    if (msg.t !== "watch.stop") return;
    const at = Date.now();
    await this.costMeter.closeWatch(att.userId, msg.trackName, at);
    const streamerId = streamerIdOf(msg.trackName);
    if (streamerId !== null) await this.stats.noteWatchStop(att.userId, streamerId, at);
    await this.room.rtcRemoveGrant(att.userId, msg.trackName);
  }

  // stream.preset (FR-27): the publisher changed their screen preset on the fly. Validate ownership of a
  // SCREEN track (webcam preset is fixed) + update the registry so a NEW watcher meters at the new rate;
  // reprice EVERY open watch of the stream (G5); broadcast `stream.updated` so viewers' StreamInfo stays
  // current. A non-owner / non-screen / unknown track → socket-local bad_message + NO reprice/broadcast.
  private async handleStreamPreset(
    ws: WebSocket,
    att: ConnAttachment,
    msg: ClientMessage,
  ): Promise<void> {
    if (msg.t !== "stream.preset") return;
    const at = Date.now();
    const ok = await this.room.rtcRepriceStream(att.userId, msg.trackName, msg.preset);
    if (!ok) {
      this.room.send(ws, { t: "error", code: "bad_message" });
      return;
    }
    await this.costMeter.repriceStream(msg.trackName, msg.preset, at);
    this.room.broadcast({ t: "stream.updated", trackName: msg.trackName, preset: msg.preset, at });
  }

  // Single, multiplexed, idempotent alarm (DO alarms are at-least-once). (a) Reconcile ghosts — any
  // voice member with zero live sockets goes through the leave path. (b) While voice still has members,
  // flush the stat accumulators (S7.1 appends costMeter.tick(now) at this exact seam). (c) Re-arm iff
  // members remain or open intervals exist, else let the alarm lapse.
  async alarm(): Promise<void> {
    const now = Date.now();
    // KV is the source of truth; re-read it so a crash-leftover seeded straight into storage is seen.
    await this.room.loadVoice();
    // (a) Reconcile ghosts (voice members with zero live sockets) through the leave path. Sequential —
    // each leaveVoice mutates shared voice + stats state, so they must not overlap (no Promise.all);
    // a `.then` chain keeps them ordered without an await inside the loop.
    const ghostIds = this.room
      .voiceState()
      .members.filter((m) => this.room.socketsOf(m.userId).length === 0)
      .map((m) => m.userId);
    let chain: Promise<void> = Promise.resolve();
    for (const userId of ghostIds) chain = chain.then(() => this.leaveVoice(userId, now));
    await chain;
    // (b) While voice still has members, bank the accumulators mid-session, then tick the egress meter
    // (§8 G5). A newly-crossed 700 GB warn threshold → broadcast cost.warning once per month-bucket.
    if (this.room.voiceState().members.length > 0) {
      await this.stats.flushOpenIntervals(now);
      if (await this.costMeter.tick(now)) {
        this.room.broadcast({
          t: "cost.warning",
          usedGB: this.costMeter.usedGB(now),
          capGB: LIMITS.egressKillGB,
          at: now,
        });
      }
    }
    // (c) Re-arm iff work remains (members or open intervals); otherwise let the alarm lapse.
    const stillActive =
      this.room.voiceState().members.length > 0 || (await this.stats.hasOpenIntervals());
    if (stillActive) await this.ctx.storage.setAlarm(now + this.alarmIntervalMs());
  }

  // Arms the alarm only if none is scheduled (never pushes an in-flight ghost-close window forward).
  private async ensureAlarmArmed(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + this.alarmIntervalMs());
    }
  }

  private alarmIntervalMs(): number {
    return this.env.TAVERN_TEST_FAST_ALARM === "1" ? FAST_ALARM_MS : LIMITS.emptyVoiceCloseMs;
  }

  // Sliding-window upload gate (FR-34 / §App-B uploadsPerUserPerHour): true when the user has created
  // fewer than the cap within the last hour. Read-only — the timestamp is recorded only after a
  // successful create (`recordUpload`), so a rejected create (bad_trim) never consumes budget.
  private allowUpload(userId: string, now: number): boolean {
    const cutoff = now - 3_600_000;
    const recent = (this.uploadTimes.get(userId) ?? []).filter((t) => t > cutoff);
    this.uploadTimes.set(userId, recent);
    return recent.length < LIMITS.rateUploadsPerHour;
  }

  private recordUpload(userId: string, now: number): void {
    const recent = this.uploadTimes.get(userId) ?? [];
    recent.push(now);
    this.uploadTimes.set(userId, recent);
  }

  private rejectFrame(ws: WebSocket): void {
    this.room.send(ws, { t: "error", code: "bad_message" });
    ws.close(CLOSE_PROTOCOL_VIOLATION, "bad_message");
  }

  private notImplemented(ws: WebSocket): void {
    this.room.send(ws, { t: "error", code: "not_implemented" });
  }
}
