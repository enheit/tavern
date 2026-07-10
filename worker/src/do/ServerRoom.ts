import { DurableObject } from "cloudflare:workers";
import {
  clientMessageSchema,
  CLOSE_BAD_TICKET,
  CLOSE_KICKED,
  CLOSE_PROTOCOL_VIOLATION,
  LIMITS,
  MemberInit,
  UserProfile,
} from "@tavern/shared";
import type { ClientMessage, ErrorCode } from "@tavern/shared";
import { migrate } from "./sql";
import { RoomState } from "./roomState";
import type { ConnAttachment, RoomMeta } from "./roomState";
import { ChatModule } from "./chat";
import { ActivityModule } from "./activity";
import { StatsModule } from "./stats";

// The Worker sets this header on EVERY DO stub call; the DO has no other ingress path, so a missing
// header on an /internal/* route means the request did not originate from the Worker → 403.
const INTERNAL_HEADER = "X-Tavern-Internal";

// The empty-voice alarm interval (ghost lifetime ≤ this = the FR-24 crash-safety close). 5 s in tests
// that opt in via the env flag (set only in .dev.vars / test env, never production config — §S3.4 task 5).
const FAST_ALARM_MS = 5_000;

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
  // connId → hello-timeout handle (in-memory; a 5 s pending timer keeps the DO from hibernating, so
  // the same instance handles the hello within the window — negligible cost, §S3.1 task 6).
  private readonly helloTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    this.routes = {
      hello: (ws, att) => this.handleHello(ws, att),
      "chat.send": (ws, att, msg) => this.handleChatSend(ws, att, msg),
      "chat.history": (ws, att, msg) => this.handleChatHistory(ws, att, msg),
      "voice.join": (ws, att) => this.handleVoiceJoin(ws, att),
      "voice.leave": (_ws, att) => this.leaveVoice(att.userId, Date.now()),
      "voice.state": (ws, att, msg) => this.handleVoiceState(ws, att, msg),
      "stream.start": (ws) => this.notImplemented(ws),
      "stream.preset": (ws) => this.notImplemented(ws),
      "stream.stop": (ws) => this.notImplemented(ws),
      "watch.start": (ws) => this.notImplemented(ws),
      "watch.stop": (ws) => this.notImplemented(ws),
      "sound.play": (ws) => this.notImplemented(ws),
      "rec.start": (ws) => this.notImplemented(ws),
      "rec.stop": (ws) => this.notImplemented(ws),
      ping: (ws) => this.notImplemented(ws),
    };
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql);
      await this.room.load();
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
      case "/internal/kick": {
        const body: { userId: string } = await request.json();
        const kickedSockets = this.room.socketsOf(body.userId);
        this.room.removeMember(body.userId);
        this.room.broadcast({ t: "member.left", userId: body.userId, at });
        // FR-39 producer: append `member.kick` and broadcast `activity.new` to the survivors (the kicked
        // user's own sockets are excluded — their UI returns to the join screen, FR-11).
        this.room.broadcast(
          { t: "activity.new", entry: this.activity.append("member.kick", body.userId, {}, at) },
          { except: kickedSockets },
        );
        for (const ws of kickedSockets) ws.close(CLOSE_KICKED, "kicked");
        return new Response(null, { status: 204 });
      }
      case "/internal/server-updated": {
        const body: { nickname: string } = await request.json();
        await this.room.patchNickname(body.nickname);
        this.room.broadcast({ t: "server.updated", nickname: body.nickname, at });
        return new Response(null, { status: 204 });
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
      // GET /internal/stats → StatsResponse (§6.1 `GET /api/servers/:id/stats`). perUser unions the
      // member cache + message senders + stream-seconds rows; messages from ChatModule.
      case "/internal/stats": {
        const snapshot = this.stats.snapshot(
          this.chat.messageCountByUser(),
          this.room.listMembers(),
        );
        return Response.json(snapshot);
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
    this.room.send(ws, this.room.helloSnapshot(att.userId, this.chat.lastMessageId()));
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
    this.room.broadcast({
      t: "activity.new",
      entry: this.activity.append("voice.leave", userId, {}, now),
    });
    this.room.broadcast({ t: "voice.state", voice: snapshot, at: now });
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
    // (b) While voice still has members, bank the accumulators mid-session. S7.1 appends
    // this.costMeter.tick(now) at this exact seam.
    if (this.room.voiceState().members.length > 0) await this.stats.flushOpenIntervals(now);
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

  private rejectFrame(ws: WebSocket): void {
    this.room.send(ws, { t: "error", code: "bad_message" });
    ws.close(CLOSE_PROTOCOL_VIOLATION, "bad_message");
  }

  private notImplemented(ws: WebSocket): void {
    this.room.send(ws, { t: "error", code: "not_implemented" });
  }
}
