import { DurableObject } from "cloudflare:workers";
import {
  clientMessageSchema,
  CLOSE_BAD_TICKET,
  CLOSE_INTERNAL_ERROR,
  CLOSE_KICKED,
  CLOSE_PROTOCOL_VIOLATION,
  LIMITS,
  MarketScope,
  PatchMarketItemRequest,
  PurchaseMarketItemRequest,
  MemberInit,
  PatchSoundRequest,
  PointConfig,
  Sound,
  UserProfile,
} from "@tavern/shared";
import type { ClientMessage, ErrorCode, ServerMessage } from "@tavern/shared";
import { z } from "zod";
import { migrate } from "./sql";
import { RoomState, rtcAuthorizeReqSchema } from "./roomState";
import type { ConnAttachment, RoomMeta, RtcAuthorizeRes } from "./roomState";
import { ChatModule } from "./chat";
import { ActivityModule } from "./activity";
import { HangoutsModule } from "./hangouts";
import { homeSnapshot } from "./home";
import { StatsModule } from "./stats";
import { CostMeter } from "./costMeter";
import { RecordingsModule } from "./recordings";
import { createScreenshot, deleteScreenshot, listScreenshots } from "./screenshots";
import { PointsModule, type PointEligibility } from "./points";
import { PollsModule, type PollMutationResult } from "./polls";
import { MarketModule } from "./market";
import {
  claimSoundPlayback,
  createSound,
  completeSoundAssetCleanup,
  deleteSound,
  getSoundPlayback,
  listSounds,
  patchSound,
  pendingSoundAssetCleanup,
  recordPlay,
  releaseSoundPlayback,
  replaceSound,
  TavernError,
} from "./soundboard";
import type { Actor, SoundPatch, SoundReplacement } from "./soundboard";
import { removeMediaObject, trackMediaInventory } from "../lib/mediaUsageInventory";

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

// Internal screenshot route bodies (Worker → DO). The Worker route already PUT the image bytes to R2
// and derived `r2Key`; the DO owns the registry row + the per-user upload rate limit + the broadcast.
const screenshotCreateBody = z.object({
  userId: z.string(),
  screenshotId: z.string(),
  r2Key: z.string(),
});
const screenshotDeleteBody = z.object({
  userId: z.string(),
  isAdmin: z.boolean(),
  screenshotId: z.string(),
});

const streamPreviewAuthorizeBody = z.object({ userId: z.uuid(), previewId: z.uuid() });
const streamPreviewCommitBody = streamPreviewAuthorizeBody.extend({
  version: z.string().min(1).max(128),
});

// Test-only seed body (S8.5): register `count` synthetic active screen shares. Reachable only via the
// mock-SFU-gated /api/__test route (index.ts) + the internal header — never in production.
const testSeedSharesBody = z.object({ count: z.number().int().min(0) });

// The `sound.updated` broadcast fires after every create/patch/delete; clients refetch the list (S9.2).
// The create body carries the not-yet-persisted sound (playCount is derived, so omitted) + its R2 key.
const createSoundBody = z.object({ sound: Sound.omit({ playCount: true }), r2Key: z.string() });
const patchSoundBody = z.object({
  soundId: z.string(),
  patch: PatchSoundRequest,
  actor: z.object({ userId: z.string(), isAdmin: z.boolean() }),
});
const replaceSoundBody = z.object({
  soundId: z.uuid(),
  replacement: Sound.pick({
    id: true,
    name: true,
    emoji: true,
    gain: true,
    sourceFileName: true,
    durationMs: true,
    trimStartMs: true,
    trimEndMs: true,
  }),
  r2Key: z.string(),
  actor: z.object({ userId: z.string(), isAdmin: z.boolean() }),
});
const deleteSoundBody = z.object({
  soundId: z.string(),
  actor: z.object({ userId: z.string(), isAdmin: z.boolean() }),
});
const pointConfigBody = z.object({ userId: z.uuid(), config: PointConfig });
const testSeedPointsBody = z.object({ userId: z.uuid(), balance: z.number().int().nonnegative() });
const marketCreateBody = z.object({
  itemId: z.uuid(),
  name: z.string().trim().min(1).max(LIMITS.marketItemNameMax),
  price: z.number().int().positive().max(LIMITS.marketPriceMax),
  userId: z.uuid(),
  isAdmin: z.boolean(),
  r2Key: z.string().min(1),
});
const marketPatchBody = z.object({
  itemId: z.uuid(),
  patch: PatchMarketItemRequest,
  isAdmin: z.boolean(),
});
const marketDeleteBody = z.object({ itemId: z.uuid(), isAdmin: z.boolean() });
const marketPurchaseBody = z.object({
  itemId: z.uuid(),
  userId: z.uuid(),
  displayName: z.string().min(1).max(LIMITS.displayNameMax),
  purchase: PurchaseMarketItemRequest,
});
const marketEquipBody = z.object({ userId: z.uuid(), itemId: z.uuid().nullable() });

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
const VOICE_RECONNECT_GRACE_MS = 15_000;
const VOICE_DISCONNECTS_KEY = "voice:disconnects";
type VoiceDisconnects = Record<string, number>;

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
  private readonly hangouts: HangoutsModule;
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
  private readonly points: PointsModule;
  private readonly polls: PollsModule;
  private readonly market: MarketModule;
  // connId → hello-timeout handle (in-memory; a 5 s pending timer keeps the DO from hibernating, so
  // the same instance handles the hello within the window — negligible cost, §S3.1 task 6).
  private readonly helloTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // userId → recent upload timestamps (sliding window, §S9.1 task 4). In-memory like the chat bucket:
  // a DO eviction only ever REFILLS a user's upload budget (never revokes) — acceptable at our scale.
  private readonly uploadTimes = new Map<string, number[]>();
  // userId → recent screenshot-capture timestamps (sliding window, § screenshots rate limit). Separate
  // from the sound-upload budget so rapid Space captures don't starve sound uploads (or vice versa).
  // In-memory per DO like the other buckets — a DO eviction only ever refills the budget, never revokes.
  private readonly screenshotTimes = new Map<string, number[]>();
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
    this.hangouts = new HangoutsModule(ctx.storage.sql);
    this.stats = new StatsModule(ctx);
    this.costMeter = new CostMeter(ctx, env);
    this.points = new PointsModule(ctx.storage.sql);
    this.polls = new PollsModule(ctx.storage, this.points);
    this.market = new MarketModule(ctx.storage, this.points);
    this.recordings = new RecordingsModule({
      sql: ctx.storage.sql,
      storage: ctx.storage,
      media: env.MEDIA,
      room: this.room,
      activity: this.activity,
    });
    this.routes = {
      hello: (ws, att, msg) => this.handleHello(ws, att, msg),
      "chat.send": (ws, att, msg) => this.handleChatSend(ws, att, msg),
      "chat.history": (ws, att, msg) => this.handleChatHistory(ws, att, msg),
      "chat.read": (ws, att, msg) => this.handleChatRead(ws, att, msg),
      "chat.edit": (ws, att, msg) => this.handleChatEdit(ws, att, msg),
      "chat.delete": (ws, att, msg) => this.handleChatDelete(ws, att, msg),
      "chat.reaction.set": (ws, att, msg) => this.handleChatReactionSet(ws, att, msg),
      "voice.join": (ws, att, msg) => this.handleVoiceJoin(ws, att, msg),
      "voice.leave": (_ws, att) => this.leaveVoice(att.userId, Date.now()),
      "voice.state": (ws, att, msg) => this.handleVoiceState(ws, att, msg),
      "stream.start": (_ws, att, msg) => this.handleStreamStart(att, msg),
      "stream.preset": (ws, att, msg) => this.handleStreamPreset(ws, att, msg),
      "stream.stop": (_ws, att, msg) => this.handleStreamStop(att, msg),
      "watch.start": (ws, att, msg) => this.handleWatchStart(ws, att, msg),
      "watch.stop": (_ws, att, msg) => this.handleWatchStop(att, msg),
      "sound.play": (ws, att, msg) => this.handleSoundPlay(ws, att, msg),
      "sound.stop": (ws, att, msg) => this.handleSoundStop(ws, att, msg),
      "rec.start": (ws, att) => this.handleRecStart(ws, att),
      "rec.stop": (ws, att) => this.handleRecStop(ws, att),
      "status.set": (_ws, _att, msg) => this.handleStatusSet(msg),
      "poll.create": (ws, att, msg) => this.handlePollMutation(ws, att, msg),
      "poll.bid": (ws, att, msg) => this.handlePollMutation(ws, att, msg),
      "poll.lock": (ws, att, msg) => this.handlePollMutation(ws, att, msg),
      "poll.resolve": (ws, att, msg) => this.handlePollMutation(ws, att, msg),
      "poll.correct": (ws, att, msg) => this.handlePollMutation(ws, att, msg),
      "poll.void": (ws, att, msg) => this.handlePollMutation(ws, att, msg),
      ping: (ws) => this.notImplemented(ws),
    };
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql);
      this.hangouts.backfill(Date.now());
      await this.room.load();
      await this.recordings.load();
      const pollDeadline = this.polls.nextDeadline();
      if (pollDeadline !== null) await this.ensureAlarmNoLaterThan(pollDeadline);
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
        const body: { userId: string; seed?: { member: unknown; serverMeta: RoomMeta } } =
          await request.json();
        // §9.5 cache rebuild: the route ships the D1 truth with every ticket; adopt only the pieces
        // missing from the cache (meta / the caller's member row) so a live cache is never clobbered
        // and an in-flight stale seed can't resurrect a just-kicked member.
        if (body.seed !== undefined) {
          await this.room.seedIfMissing(MemberInit.parse(body.seed.member), body.seed.serverMeta);
        }
        return Response.json({ ticket: await this.room.createTicket(body.userId) });
      }
      case "/internal/member-join": {
        const body: { member: unknown; serverMeta: RoomMeta } = await request.json();
        const member = MemberInit.parse(body.member);
        this.room.upsertMember(member);
        this.chat.refreshReactorDisplayName(member.userId, member.displayName);
        this.chat.initializeReadCursor(member.userId);
        await this.room.setMeta(body.serverMeta);
        const joinedMember = this.room
          .listMembers()
          .find((candidate) => candidate.userId === member.userId) ?? {
          ...member,
          presence: this.room.presenceOf(member.userId),
        };
        this.room.broadcast({
          t: "member.joined",
          member: joinedMember,
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
        this.chat.refreshReactorDisplayName(profile.userId, profile.displayName);
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
      case "/internal/polls": {
        const userId = url.searchParams.get("userId");
        if (userId === null) {
          return Response.json({ error: "bad_request" satisfies ErrorCode }, { status: 400 });
        }
        const before = url.searchParams.get("before");
        const limit = url.searchParams.get("limit");
        await this.processPollDue(at);
        return Response.json(
          this.polls.page(
            userId,
            before === null ? undefined : Number(before),
            limit === null ? LIMITS.historyPageSize : Number(limit),
          ),
        );
      }
      case "/internal/market": {
        const userId = url.searchParams.get("userId");
        const scope = MarketScope.safeParse(url.searchParams.get("scope") ?? "shop");
        if (userId === null || !scope.success) {
          return Response.json({ error: "bad_request" satisfies ErrorCode }, { status: 400 });
        }
        const page = this.market.page(scope.data, userId, url.searchParams.get("cursor"));
        if (page === null) {
          return Response.json({ error: "bad_request" satisfies ErrorCode }, { status: 400 });
        }
        return Response.json(page);
      }
      case "/internal/market/create": {
        const body = marketCreateBody.parse(await request.json());
        if (!body.isAdmin) {
          return Response.json({ error: "not_admin" satisfies ErrorCode }, { status: 403 });
        }
        if (!this.allowUpload(body.userId, at)) {
          return Response.json({ error: "rate_limited" satisfies ErrorCode }, { status: 429 });
        }
        const item = this.market.create({
          id: body.itemId,
          name: body.name,
          price: body.price,
          createdBy: body.userId,
          r2Key: body.r2Key,
          now: at,
        });
        this.recordUpload(body.userId, at);
        this.room.broadcast({ t: "market.updated", at });
        return Response.json({ item });
      }
      case "/internal/market/patch": {
        const body = marketPatchBody.parse(await request.json());
        if (!body.isAdmin) {
          return Response.json({ error: "not_admin" satisfies ErrorCode }, { status: 403 });
        }
        const result = this.market.patch(body.itemId, body.patch, at);
        if (!result.ok) return this.marketError(result.code);
        this.room.broadcast({ t: "market.updated", at });
        return Response.json({ item: result.value });
      }
      case "/internal/market/delete": {
        const body = marketDeleteBody.parse(await request.json());
        if (!body.isAdmin) {
          return Response.json({ error: "not_admin" satisfies ErrorCode }, { status: 403 });
        }
        const result = this.market.delete(body.itemId);
        if (!result.ok) return this.marketError(result.code);
        this.room.broadcast({ t: "market.updated", at });
        await this.cleanupMarketAssets();
        return Response.json({ itemId: result.value.itemId });
      }
      case "/internal/market/purchase": {
        const body = marketPurchaseBody.parse(await request.json());
        const result = this.market.purchase({
          itemId: body.itemId,
          userId: body.userId,
          displayName: body.displayName,
          expectedRevision: body.purchase.expectedRevision,
          wearImmediately: body.purchase.wearImmediately,
          now: at,
        });
        if (!result.ok) return this.marketError(result.code);
        this.room.broadcast({ t: "market.updated", at });
        this.room.broadcast({
          t: "member.icon.updated",
          userId: body.userId,
          icon: result.value.equippedIcon,
          at,
        });
        this.broadcastPointSnapshots(at);
        return Response.json(result.value);
      }
      case "/internal/market/equip": {
        const body = marketEquipBody.parse(await request.json());
        const result = this.market.equip(body.userId, body.itemId);
        if (!result.ok) return this.marketError(result.code);
        this.room.broadcast({
          t: "member.icon.updated",
          userId: body.userId,
          icon: result.value,
          at,
        });
        return Response.json({ icon: result.value });
      }
      // GET /internal/home is a read-only bounded projection. Due hangouts are finalized by the room
      // alarm; a dashboard refresh must never turn into a storage-writing fan-out.
      case "/internal/home": {
        return Response.json(
          homeSnapshot({
            sql: this.ctx.storage.sql,
            hangouts: this.hangouts,
            points: this.points,
            memberIds: this.room.listMembers().map((member) => member.userId),
            now: at,
            recordings: this.recordings,
          }),
        );
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
      case "/internal/stream-preview/authorize": {
        const parsed = streamPreviewAuthorizeBody.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json({ ok: false, error: "bad_request" satisfies ErrorCode });
        }
        return Response.json(
          await this.room.authorizeStreamPreview(parsed.data.userId, parsed.data.previewId, at),
        );
      }
      case "/internal/stream-preview/commit": {
        const parsed = streamPreviewCommitBody.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json({ ok: false, error: "bad_request" satisfies ErrorCode });
        }
        return Response.json(
          await this.room.commitStreamPreview(
            parsed.data.userId,
            parsed.data.previewId,
            parsed.data.version,
            at,
          ),
        );
      }
      case "/internal/points/config": {
        if (request.method !== "PUT") {
          return Response.json({ error: "bad_request" satisfies ErrorCode }, { status: 400 });
        }
        const body = pointConfigBody.parse(await request.json());
        this.points.updateConfig(body.config, body.userId, at);
        this.broadcastPointSnapshots(at);
        return Response.json(this.points.config());
      }
      case "/internal/test/seed-points": {
        if (this.env.TAVERN_TEST !== "1") {
          return Response.json({ error: "not_found" satisfies ErrorCode }, { status: 404 });
        }
        const body = testSeedPointsBody.parse(await request.json());
        this.points.setBalanceForTest(body.userId, body.balance, at);
        this.broadcastPointSnapshots(at);
        return Response.json(this.points.snapshot(body.userId, at));
      }
      // GET /internal/stats → StatsResponse (§6.1 `GET /api/servers/:id/stats`). perUser unions the
      // member cache + message senders + stream-seconds rows; messages from ChatModule.
      case "/internal/stats": {
        const snapshot = await this.stats.snapshot(
          this.chat.messageCountByUser(),
          this.room.listMembers(),
          at,
        );
        return Response.json(snapshot);
      }
      // GET /internal/sounds → { sounds } (§6.1 `GET /api/servers/:id/sounds`), ordered playCount DESC
      // then createdAt DESC (FR-37). The Worker route validates against the shared SoundsResponse.
      case "/internal/sounds": {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Math.min(
          Math.max(1, Number(url.searchParams.get("limit") ?? LIMITS.historyPageSize)),
          LIMITS.historyPageSize,
        );
        const sounds = listSounds(this.ctx.storage.sql).slice(offset, offset + limit + 1);
        return Response.json({
          sounds: sounds.slice(0, limit),
          hasMore: sounds.length > limit,
        });
      }
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
      case "/internal/sounds/replace": {
        const body = replaceSoundBody.parse(await request.json());
        if (!this.allowUpload(body.actor.userId, at)) {
          return Response.json({ error: "rate_limited" satisfies ErrorCode }, { status: 429 });
        }
        try {
          const replacement: SoundReplacement = body.replacement;
          const actor: Actor = body.actor;
          const sound = this.ctx.storage.transactionSync(() =>
            replaceSound(this.ctx.storage.sql, body.soundId, replacement, body.r2Key, actor),
          );
          this.recordUpload(body.actor.userId, at);
          this.room.broadcast({ t: "sound.updated", at });
          await this.cleanupSoundAssets();
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
          const { r2Key } = this.ctx.storage.transactionSync(() =>
            deleteSound(this.ctx.storage.sql, body.soundId, actor),
          );
          this.room.broadcast({ t: "sound.updated", at });
          await this.cleanupSoundAssets();
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
      case "/internal/recordings": {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? LIMITS.historyPageSize);
        return Response.json(this.recordings.list(offset, limit));
      }
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
      // § screenshots (§6.1). The Worker route PUTs the image to R2 + resolves the caller/admin; the DO
      // owns the registry row, the per-user capture rate limit, and the `screenshot.updated` broadcast.
      // GET /internal/screenshots → list (newest first).
      case "/internal/screenshots": {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? LIMITS.historyPageSize);
        return Response.json(listScreenshots(this.ctx.storage.sql, offset, limit));
      }
      // POST /internal/screenshots/create → rate-limit the capturer, insert the row, broadcast the nudge.
      // On a rate-limit reject the Worker deletes the R2 object it already PUT (mirrors sounds/create).
      case "/internal/screenshots/create": {
        const body = screenshotCreateBody.parse(await request.json());
        if (!this.allowScreenshot(body.userId, at)) {
          return Response.json({ error: "rate_limited" satisfies ErrorCode }, { status: 429 });
        }
        const screenshot = createScreenshot(this.ctx.storage.sql, {
          id: body.screenshotId,
          capturedBy: body.userId,
          r2Key: body.r2Key,
          createdAt: at,
        });
        this.recordScreenshot(body.userId, at);
        this.room.broadcast({ t: "screenshot.updated", at });
        return Response.json({ screenshot });
      }
      // POST /internal/screenshots/delete → capturer/admin delete; returns its R2 key + broadcasts.
      case "/internal/screenshots/delete": {
        const body = screenshotDeleteBody.parse(await request.json());
        try {
          const { r2Key } = deleteScreenshot(this.ctx.storage.sql, body.screenshotId, {
            userId: body.userId,
            isAdmin: body.isAdmin,
          });
          this.room.broadcast({ t: "screenshot.updated", at });
          return Response.json({ r2Key });
        } catch (err: unknown) {
          if (err instanceof TavernError) {
            return Response.json({ error: err.code }, { status: soundErrorStatus(err.code) });
          }
          throw err;
        }
      }
      // POST /internal/test/seed-shares (S8.5, mock-SFU only) → register `count` synthetic active screen
      // shares in the RTC registry (G4 cap exercise). Guarded upstream by the /api/__test env gate.
      case "/internal/test/seed-shares": {
        const body = testSeedSharesBody.parse(await request.json());
        return Response.json({ screens: await this.room.rtcSeedShares(body.count) });
      }
      // POST /internal/test/set-egress (S12.3, TAVERN_TEST only) → seed the egress meter so the §8
      // kill-switch e2e can cross the warn/kill thresholds. The handler itself 404s without the flag.
      case "/internal/test/set-egress":
        return this.costMeter.handleSetEgress(request);
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
    try {
      await this.routes[msg.t](ws, att, msg);
    } catch (err: unknown) {
      // §9.5: an uncaught handler failure must never strand the socket silently — during the
      // handshake the client blocks its entire boot on the hello.ok reply (and handleHello clears
      // the server-side hello timer BEFORE building the snapshot, so nothing else would ever close
      // this socket). Close 1011 → the client reconnects with a fresh ticket, and ticket issuance
      // re-seeds a wiped meta/member cache from D1 (seedIfMissing), so the retry heals.
      console.error("ws route failed", msg.t, err);
      ws.close(CLOSE_INTERNAL_ERROR, "internal");
    }
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
    // A transient network handoff must not tear down every SFU session. The last socket starts a
    // short durable lease; a reconnecting hello cancels it, otherwise the alarm performs the leave.
    const otherMediaSocket = this.hasMediaSocket(att.userId, ws);
    if (
      !otherMediaSocket &&
      this.room.voiceState().members.some((member) => member.userId === att.userId)
    ) {
      await this.scheduleVoiceDisconnect(att.userId, now);
    }
  }

  private async handleHello(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): Promise<void> {
    if (msg.t !== "hello") return;
    const at = Date.now();
    const firstHello = !att.hello;
    const mediaResume = msg.mediaResume === true && msg.mediaReset !== true;
    if (firstHello) {
      const next: ConnAttachment = { ...att, hello: true, mediaResume };
      ws.serializeAttachment(next);
      const timer = this.helloTimers.get(att.connId);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.helloTimers.delete(att.connId);
      }
    }
    // Reconnect replays the full snapshot (§6.2 no delta sync); a repeat hello is idempotent. Browser
    // capture cannot survive document replacement, so an owning tab's reload sends mediaReset even
    // while its old socket briefly overlaps the new one. Other fresh connections fall back to socket
    // ownership: a second passive tab does not disturb an existing media tab, while a reconnect after
    // an already-closed owner clears its abandoned voice/RTC lifetime before taking the snapshot.
    if (msg.mediaReset === true) {
      await this.cancelVoiceDisconnect(att.userId);
      if (this.room.voiceState().members.some((member) => member.userId === att.userId)) {
        await this.leaveVoice(att.userId, at);
      }
    } else if (mediaResume) {
      await this.cancelVoiceDisconnect(att.userId);
    } else if (
      firstHello &&
      !this.hasMediaSocket(att.userId, ws) &&
      this.room.voiceState().members.some((member) => member.userId === att.userId)
    ) {
      await this.cancelVoiceDisconnect(att.userId);
      await this.leaveVoice(att.userId, at);
    }
    // The active-streams list is read from the RTC registry (async KV) so a client connecting AFTER
    // somebody else's share started still learns it (`stream.added` fires once, at publish). The hello
    // timer was cleared above (before the await), so nothing closes this socket during the read.
    const streams = await this.room.activeStreams();
    await this.processPollDue(at);
    const readState = this.chat.readState(att.userId);
    const costStatus = await this.costMeter.status(at);
    this.room.send(
      ws,
      this.room.helloSnapshot(
        att.userId,
        this.chat.lastMessageId(),
        readState,
        costStatus,
        this.recordings.state(),
        streams,
        this.points.snapshot(att.userId, at),
        this.polls.visible(att.userId, at),
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
      ...(msg.gif === undefined ? {} : { gif: msg.gif }),
      ...(msg.image === undefined ? {} : { image: msg.image }),
      ...(msg.replyToId === undefined ? {} : { replyToId: msg.replyToId }),
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

  private async handlePollMutation(
    ws: WebSocket,
    att: ConnAttachment,
    msg: ClientMessage,
  ): Promise<void> {
    if (
      msg.t !== "poll.create" &&
      msg.t !== "poll.bid" &&
      msg.t !== "poll.lock" &&
      msg.t !== "poll.resolve" &&
      msg.t !== "poll.correct" &&
      msg.t !== "poll.void"
    ) {
      return;
    }
    const now = Date.now();
    await this.processPollDue(now);
    const actor = this.room.listMembers().find((member) => member.userId === att.userId);
    if (actor === undefined) {
      this.room.send(ws, { t: "error", code: "not_member", ref: msg.requestId });
      return;
    }
    let result: PollMutationResult;
    switch (msg.t) {
      case "poll.create":
        result = this.polls.create({
          creatorId: actor.userId,
          creatorDisplayName: actor.displayName,
          question: msg.question,
          outcomes: msg.outcomes,
          durationSeconds: msg.durationSeconds,
          now,
        });
        break;
      case "poll.bid":
        result = this.polls.bid({
          pollId: msg.pollId,
          outcomeId: msg.outcomeId,
          userId: actor.userId,
          displayName: actor.displayName,
          stake: msg.stake,
          now,
        });
        break;
      case "poll.lock":
        result = this.polls.lock(msg.pollId, actor.userId, actor.isAdmin, now);
        break;
      case "poll.resolve":
        result = this.polls.resolve(msg.pollId, msg.outcomeId, actor.userId, actor.isAdmin, now);
        break;
      case "poll.correct":
        result = this.polls.correct(msg.pollId, msg.outcomeId, actor.userId, actor.isAdmin, now);
        break;
      case "poll.void":
        result = this.polls.void(msg.pollId, actor.userId, actor.isAdmin, now);
        break;
    }
    if (!result.ok) {
      this.room.send(ws, { t: "error", code: result.code, ref: msg.requestId });
      return;
    }
    this.broadcastPoll(result.poll.id, now, msg.requestId, actor.userId);
    if (result.affectedUserIds.length > 0) this.broadcastPointSnapshots(now);
    const deadline = this.polls.nextDeadline();
    if (deadline !== null) await this.ensureAlarmNoLaterThan(deadline);
  }

  // chat.history: paginated read (ChatModule), replied only to the requesting socket.
  private handleChatHistory(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "chat.history") return;
    const page = this.chat.history({
      userId: att.userId,
      mode: msg.mode,
      ...(msg.cursorId === undefined ? {} : { cursorId: msg.cursorId }),
      limit: msg.limit,
    });
    this.room.send(ws, {
      t: "chat.page",
      requestId: msg.requestId,
      mode: msg.mode,
      messages: page.messages,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
    });
  }

  private handleChatRead(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "chat.read") return;
    const state = this.chat.markRead(att.userId, msg.messageId);
    if (state === null) {
      this.room.send(ws, { t: "error", code: "bad_message" });
      return;
    }
    this.room.broadcast({ t: "chat.read-state", ...state }, { toUserId: att.userId });
  }

  private handleChatEdit(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "chat.edit") return;
    const result = this.chat.edit({
      userId: att.userId,
      messageId: msg.messageId,
      body: msg.body,
      members: this.room.listMembers(),
      now: Date.now(),
    });
    if (!result.ok) {
      this.room.send(ws, { t: "error", code: result.code, ref: msg.requestId });
      return;
    }
    this.room.broadcast(
      { t: "chat.updated", message: result.message, requestId: msg.requestId },
      { toUserId: att.userId },
    );
    this.room.broadcast(
      { t: "chat.updated", message: result.message },
      { except: this.room.socketsOf(att.userId) },
    );
  }

  private async handleChatDelete(
    ws: WebSocket,
    att: ConnAttachment,
    msg: ClientMessage,
  ): Promise<void> {
    if (msg.t !== "chat.delete") return;
    const result = this.chat.delete({
      userId: att.userId,
      messageId: msg.messageId,
      now: Date.now(),
    });
    if (!result.ok) {
      this.room.send(ws, { t: "error", code: result.code, ref: msg.requestId });
      return;
    }
    if (result.imageId !== undefined) await this.cleanupChatImages();
    this.room.broadcast(
      { t: "chat.deleted", message: result.message, requestId: msg.requestId },
      { toUserId: att.userId },
    );
    this.room.broadcast(
      { t: "chat.deleted", message: result.message },
      { except: this.room.socketsOf(att.userId) },
    );
    for (const userId of this.room.connectedUserIds()) {
      this.room.broadcast(
        { t: "chat.read-state", ...this.chat.readState(userId) },
        { toUserId: userId },
      );
    }
  }

  private handleChatReactionSet(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "chat.reaction.set") return;
    const actor = this.room.listMembers().find((member) => member.userId === att.userId);
    if (actor === undefined) {
      this.room.send(ws, { t: "error", code: "not_member", ref: msg.requestId });
      return;
    }
    const result = this.chat.setReaction({
      userId: att.userId,
      displayName: actor.displayName,
      messageId: msg.messageId,
      emoji: msg.emoji,
      reacted: msg.reacted,
      now: Date.now(),
    });
    if (!result.ok) {
      this.room.send(ws, { t: "error", code: result.code, ref: msg.requestId });
      return;
    }
    const update: Extract<ServerMessage, { t: "chat.reaction.updated" }> = {
      t: "chat.reaction.updated",
      messageId: msg.messageId,
      emoji: result.emoji,
      reaction: result.reaction,
    };
    this.room.broadcast({ ...update, requestId: msg.requestId }, { toUserId: att.userId });
    if (result.changed) {
      this.room.broadcast(update, { except: this.room.socketsOf(att.userId) });
    }
  }

  // sound.play (FR-36): unknown soundId → `not_found`; an already-active sound is an idempotent no-op;
  // otherwise append one `sound_plays` row (FR-37 stats) and broadcast `sound.played` to ALL sockets —
  // the sender included, so it plays on its own broadcast receipt. The active registry is keyed by
  // soundId rather than userId so different sounds may overlap but the same sound never stacks.
  private handleSoundPlay(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "sound.play") return;
    const at = Date.now();
    if (!this.room.voiceState().members.some((member) => member.userId === att.userId)) {
      this.room.send(ws, { t: "error", code: "not_in_voice" });
      return;
    }
    const playback = getSoundPlayback(this.ctx.storage.sql, msg.soundId);
    if (playback === null) {
      this.room.send(ws, { t: "error", code: "not_found" });
      return;
    }
    const claimed = this.ctx.storage.transactionSync(() => {
      if (
        !claimSoundPlayback(
          this.ctx.storage.sql,
          msg.soundId,
          at,
          playback.trimEndMs - playback.trimStartMs,
        )
      )
        return false;
      recordPlay(this.ctx.storage.sql, msg.soundId, att.userId, at);
      return true;
    });
    if (!claimed) return;
    this.room.broadcast({
      t: "sound.played",
      soundId: msg.soundId,
      byUserId: att.userId,
      at,
      trimStartMs: playback.trimStartMs,
      trimEndMs: playback.trimEndMs,
      gain: playback.gain,
    });
  }

  private handleSoundStop(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "sound.stop") return;
    if (!this.room.voiceState().members.some((member) => member.userId === att.userId)) {
      this.room.send(ws, { t: "error", code: "not_in_voice" });
      return;
    }
    if (getSoundPlayback(this.ctx.storage.sql, msg.soundId) === null) {
      this.room.send(ws, { t: "error", code: "not_found" });
      return;
    }
    releaseSoundPlayback(this.ctx.storage.sql, msg.soundId);
    this.room.broadcast({
      t: "sound.stopped",
      soundId: msg.soundId,
      byUserId: att.userId,
      at: Date.now(),
    });
  }

  // voice.join (FR-18/24): idempotent. A genuinely new join appends the member, opens the session on
  // the first member, appends a `voice.join` activity, broadcasts the full snapshot to ALL sockets
  // (FR-24: non-voice members see the timer), and ensures the crash-safety alarm is armed. A repeat
  // join is a no-op that just re-sends the current snapshot to the requester.
  private async handleVoiceJoin(
    ws: WebSocket,
    att: ConnAttachment,
    msg: ClientMessage,
  ): Promise<void> {
    if (msg.t !== "voice.join" || msg.mediaReadyVersion !== 2) {
      this.room.send(ws, { t: "error", code: "voice_client_update_required" });
      return;
    }
    const at = Date.now();
    const beforeIds = this.room.voiceState().members.map((member) => member.userId);
    const already = this.room.voiceState().members.some((m) => m.userId === att.userId);
    const snapshot = this.room.voiceJoin(att.userId, at, msg.mediaReadyVersion);
    ws.serializeAttachment({ ...att, hello: true, mediaResume: true } satisfies ConnAttachment);
    if (already) {
      this.room.send(ws, { t: "voice.state", voice: snapshot, at });
      return;
    }
    await this.room.persistVoice();
    const afterIds = snapshot.members.map((member) => member.userId);
    if (this.hangouts.noteVoiceChange(beforeIds, afterIds, at)) {
      this.room.broadcast({ t: "hangout.updated", at });
    }
    await this.syncPoints(at);
    this.room.broadcast({
      t: "activity.new",
      entry: this.activity.append("voice.join", att.userId, {}, at),
    });
    this.room.broadcast({ t: "voice.state", voice: snapshot, at });
    await this.ensureAlarmArmed(at);
  }

  // voice.leave path — shared by explicit leave and alarm expiry after the reconnect grace window.
  // Idempotent: a user not in voice is a no-op (so a double alarm never double-closes). Closes the
  // leaver's open stream/watch intervals, appends a `voice.leave` activity, and broadcasts the new
  // snapshot to all remaining sockets.
  private async leaveVoice(userId: string, now: number): Promise<void> {
    if (!this.room.voiceState().members.some((m) => m.userId === userId)) return;
    const beforeIds = this.room.voiceState().members.map((member) => member.userId);
    const { snapshot } = this.room.voiceLeave(userId, now);
    await this.room.persistVoice();
    await this.stats.closeAllFor(userId, now);
    // Drop the leaver's SFU sessions/tracks/grants + flush their open meter watches (§S3.4 disconnect
    // cleanup path; the SFU GCs the dead session itself). Broadcasts stream.removed for their video.
    await this.room.rtcCleanupFor(userId, this.costMeter, now);
    await this.cleanupStreamPreviews();
    await this.syncPoints(now);
    // FR-25 dirty end: if the leaver owns the active recording without a prior graceful rec.stop, cancel
    // it (abort R2 multipart, delete row, broadcast inactive, aborted activity). No-op otherwise, so a
    // graceful stop-then-leave or a non-recorder's leave costs nothing.
    await this.recordings.handleUserGone(userId, now);
    this.hangouts.noteVoiceChange(
      beforeIds,
      snapshot.members.map((member) => member.userId),
      now,
    );
    const hangoutDeadline = this.hangouts.pendingDeadline();
    if (hangoutDeadline !== null) await this.ensureAlarmNoLaterThan(hangoutDeadline);
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

  // status.set (§ header status): any member sets the shared free-text server status. The wire schema
  // caps it at 128 chars; we trim surrounding whitespace, persist to KV, and broadcast `status.updated`
  // to every socket. Last write wins (a single KV value — a concurrent set just overwrites). Empty text
  // clears the status. No admin gate: the socket is already authenticated as a server member.
  private async handleStatusSet(msg: ClientMessage): Promise<void> {
    if (msg.t !== "status.set") return;
    const text = msg.text.trim();
    if (!(await this.room.setStatus(text))) return;
    this.room.broadcast({ t: "status.updated", text, at: Date.now() });
  }

  // voice.state (FR-26): relay the caller's self mute/deafen flags into the snapshot; broadcast to all.
  private async handleVoiceState(
    ws: WebSocket,
    att: ConnAttachment,
    msg: ClientMessage,
  ): Promise<void> {
    if (msg.t !== "voice.state") return;
    const at = Date.now();
    const { snapshot, changed } = this.room.setVoiceFlags(att.userId, {
      muted: msg.muted,
      deafened: msg.deafened,
    });
    if (!changed) return;
    await this.room.persistVoice();
    await this.syncPoints(at);
    this.room.broadcast({ t: "voice.state", voice: snapshot, at });
  }

  // stream.start (FR-39/FR-40): the publisher's "hours streamed" clock opens (server-authoritative,
  // idempotent per user — a 2nd concurrent share alongside a screen, FR-29, does NOT restart it) AND a
  // `stream.start` activity entry is appended + broadcast (FR-39, one per share). The stream itself was
  // registered + `stream.added`-broadcast on the publish authorize (S7.1 HTTP path); this frame drives
  // the stat + activity only. meta carries kind + trackName for the (future) activity detail.
  private async handleStreamStart(att: ConnAttachment, msg: ClientMessage): Promise<void> {
    if (msg.t !== "stream.start") return;
    const at = Date.now();
    await this.stats.noteStreamStart(att.userId, at);
    this.room.broadcast({
      t: "activity.new",
      entry: this.activity.append(
        "stream.start",
        att.userId,
        { kind: msg.kind, trackName: msg.trackName },
        at,
      ),
    });
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
    // Unregister the stopped video track + its screenAudio companion and broadcast stream.removed so
    // watchers drop the tile. The client's parallel SFU close is a pure passthrough (§6.1) that never
    // touches the DO registry, and the disconnect sweep only fires on a socket close — a graceful
    // stop.start/stop must clean the registry here (reuses the op:'close' unregister + broadcast).
    const audioCompanion = msg.trackName.startsWith("screen:")
      ? [msg.trackName.replace(/^screen:/, "screenAudio:")]
      : [];
    await this.room.rtcAuthorize(
      { op: "close", userId: att.userId, trackNames: [msg.trackName, ...audioCompanion] },
      this.costMeter,
      now,
    );
    await this.cleanupStreamPreviews();
    await this.syncPoints(now);
    // FR-39: record the share stop (one entry per stopped track) + broadcast live to open Activity tabs.
    this.room.broadcast({
      t: "activity.new",
      entry: this.activity.append("stream.stop", att.userId, { trackName: msg.trackName }, now),
    });
  }

  // watch.start (G1/FR-40): grant the viewer the pull at the HIGH layer (G3 amended — every watcher
  // pulls "h" from the initial pull, so the meter must price "h" from the first tick: op:'layer'
  // repricing never fires under the always-h UI), open the cost-meter watch at the stream's CURRENT
  // registry preset (G5), and start the (viewer→streamer) watch-stat clock. No wire ack — the
  // client's pull is authorized against the grant this seeds. An unknown / non-video track →
  // socket-local bad_message (the client reverts to idle on the error frame).
  private async handleWatchStart(
    ws: WebSocket,
    att: ConnAttachment,
    msg: ClientMessage,
  ): Promise<void> {
    if (msg.t !== "watch.start") return;
    const at = Date.now();
    // §8 G5 kill switch (S12.3): at the cap the watch is rejected HERE — before any grant, meter
    // watch, or SFU state exists (G1: rejection precedes SFU ops). The REST pull path's isBlocked
    // check (roomState op:pull) stays as the belt for pulls that bypass watch.start. Voice is
    // untouched: mic pulls carry no grant and skip the blocked check.
    if (await this.costMeter.isBlocked(at)) {
      this.room.send(ws, { t: "error", code: "cost_cap" });
      return;
    }
    const info = await this.room.rtcWatchable(msg.trackName);
    if (info === null || info.streamerId === att.userId) {
      this.room.send(ws, { t: "error", code: "bad_message" });
      return;
    }
    await this.room.rtcAddGrant(att.userId, msg.trackName, "h");
    await this.costMeter.openWatch(att.userId, msg.trackName, info.preset, "h", at);
    await this.stats.noteWatchStart(att.userId, info.streamerId, at);
    await this.syncPoints(at);
    // § watching indicator: the grant set changed — fan the fresh watch.state snapshot to everyone.
    await this.room.broadcastWatching(at);
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
    await this.syncPoints(at);
    // § watching indicator: the grant set changed — fan the fresh watch.state snapshot to everyone.
    await this.room.broadcastWatching(at);
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

  // Single, multiplexed, idempotent alarm (DO alarms are at-least-once). It expires reconnect leases,
  // projects live counters without settling them, processes due work, and re-arms only while work or
  // a deadline remains.
  async alarm(): Promise<void> {
    const now = Date.now();
    await this.cleanupChatImages();
    await this.cleanupSoundAssets();
    await this.cleanupMarketAssets();
    await this.cleanupStreamPreviews();
    // KV is the source of truth; re-read it so a crash-leftover seeded straight into storage is seen.
    await this.room.loadVoice();
    // (a) Reconcile ghosts (voice members with zero live sockets) through the leave path. Sequential —
    // each leaveVoice mutates shared voice + stats state, so they must not overlap (no Promise.all);
    // a `.then` chain keeps them ordered without an await inside the loop.
    const legacyIds = this.room
      .voiceState()
      .members.filter((m) => m.mediaReadyVersion !== 2)
      .map((m) => m.userId);
    for (const userId of legacyIds) {
      for (const ws of this.room.socketsOf(userId)) {
        this.room.send(ws, { t: "error", code: "voice_client_update_required" });
      }
    }
    const disconnects = (await this.ctx.storage.get<VoiceDisconnects>(VOICE_DISCONNECTS_KEY)) ?? {};
    let disconnectsChanged = false;
    for (const member of this.room.voiceState().members) {
      if (this.hasMediaSocket(member.userId)) {
        if (disconnects[member.userId] !== undefined) {
          delete disconnects[member.userId];
          disconnectsChanged = true;
        }
      } else if (disconnects[member.userId] === undefined) {
        disconnects[member.userId] = now + VOICE_RECONNECT_GRACE_MS;
        disconnectsChanged = true;
      }
    }
    const expiredIds = Object.entries(disconnects)
      .filter(([, deadline]) => deadline <= now)
      .map(([userId]) => userId);
    const leavingIds = [...new Set([...legacyIds, ...expiredIds])];
    let chain: Promise<void> = Promise.resolve();
    for (const userId of leavingIds) chain = chain.then(() => this.leaveVoice(userId, now));
    await chain;
    for (const userId of leavingIds) {
      if (disconnects[userId] !== undefined) {
        delete disconnects[userId];
        disconnectsChanged = true;
      }
    }
    if (disconnectsChanged) await this.writeVoiceDisconnects(disconnects);
    this.broadcastPointSnapshots(now);
    await this.processPollDue(now);
    if (this.hangouts.finalizeDue(now)) this.room.broadcast({ t: "hangout.updated", at: now });
    // While voice still has members, project the live egress meter without banking open intervals.
    // A newly-crossed 700 GB warn threshold → broadcast cost.warning once per month-bucket.
    if (this.room.voiceState().members.length > 0) {
      if (await this.costMeter.tick(now)) {
        this.room.broadcast({
          t: "cost.warning",
          usedGB: await this.costMeter.usedGB(now),
          capGB: LIMITS.egressKillGB,
          at: now,
        });
      }
      // Live egress readout for the Stats tab — same CostStatus shape hello.ok snapshots, refreshed
      // every tick while anyone is in voice (the only time the meter can move).
      this.room.broadcast({ t: "cost.update", cost: await this.costMeter.status(now), at: now });
    }
    // (c) Re-arm iff work remains (members or open intervals); otherwise let the alarm lapse.
    const stillActive =
      this.room.voiceState().members.length > 0 ||
      (await this.stats.hasOpenIntervals()) ||
      this.chat.hasPendingImageCleanup() ||
      pendingSoundAssetCleanup(this.ctx.storage.sql).length > 0 ||
      this.market.pendingAssetCleanup().length > 0 ||
      (await this.room.hasPendingStreamPreviewCleanup());
    const hangoutDeadline = this.hangouts.pendingDeadline();
    const pollDeadline = this.polls.nextDeadline();
    const voiceDisconnectDeadline = Object.values(disconnects).toSorted((a, b) => a - b)[0] ?? null;
    const routineDeadline = stillActive ? now + this.alarmIntervalMs() : null;
    const nextDeadline =
      [routineDeadline, hangoutDeadline, pollDeadline, voiceDisconnectDeadline]
        .filter((deadline): deadline is number => deadline !== null)
        .toSorted((a, b) => a - b)[0] ?? null;
    if (nextDeadline !== null) await this.ctx.storage.setAlarm(nextDeadline);
  }

  private async syncPoints(now: number, broadcast = true): Promise<void> {
    const eligibility = await this.pointEligibility();
    this.points.replaceSources(eligibility, now);
    if (broadcast) this.broadcastPointSnapshots(now);
  }

  private async pointEligibility(): Promise<PointEligibility> {
    const voice = this.room.voiceState();
    const voiceIds = new Set(voice.members.map((member) => member.userId));
    const conversational = voice.members
      .filter((member) => !member.muted && !member.deafened)
      .map((member) => member.userId);
    const conversation = conversational.length >= 2 ? conversational : [];
    const streaming = new Set<string>();
    const watching = new Set<string>();
    const rtc = await this.room.rtcSnapshot();
    for (const [viewerId, grants] of Object.entries(rtc.grants)) {
      if (!voiceIds.has(viewerId)) continue;
      for (const trackName of Object.keys(grants)) {
        const track = rtc.tracks[trackName];
        if (
          track === undefined ||
          (track.kind !== "screen" && track.kind !== "cam") ||
          track.userId === viewerId ||
          !voiceIds.has(track.userId)
        ) {
          continue;
        }
        watching.add(viewerId);
        streaming.add(track.userId);
      }
    }
    return {
      conversation,
      streaming: [...streaming],
      watching: [...watching],
    };
  }

  private broadcastPointSnapshots(at: number): void {
    const userIds = this.room.connectedUserIds();
    const pointLeaderboard = this.points.leaderboard(
      this.room.listMembers().map((member) => member.userId),
      at,
    );
    for (const userId of userIds) {
      this.room.broadcast(
        { t: "points.updated", points: this.points.snapshot(userId, at), pointLeaderboard, at },
        { toUserId: userId },
      );
    }
  }

  private broadcastPoll(pollId: string, at: number, requestId?: string, actorId?: string): void {
    for (const userId of this.room.connectedUserIds()) {
      this.room.broadcast(
        {
          t: "poll.updated",
          poll: this.polls.poll(pollId, userId),
          ...(requestId !== undefined && userId === actorId ? { requestId } : {}),
          at,
        },
        { toUserId: userId },
      );
    }
  }

  private async processPollDue(now: number): Promise<void> {
    const due = this.polls.processDue(now);
    for (const poll of due.polls) this.broadcastPoll(poll.id, now);
    if (due.affectedUserIds.length > 0) this.broadcastPointSnapshots(now);
  }

  private async cleanupChatImages(): Promise<void> {
    const pending = this.chat.pendingImageCleanup();
    await pending.reduce<Promise<void>>(
      (chain, imageId) =>
        chain.then(async () => {
          try {
            await this.env.MEDIA.delete(`${this.room.id()}/chat-images/${imageId}.webp`);
            await trackMediaInventory(
              removeMediaObject(this.env.DB, `${this.room.id()}/chat-images/${imageId}.webp`),
              "delete",
              `${this.room.id()}/chat-images/${imageId}.webp`,
            );
            this.chat.completeImageCleanup(imageId);
          } catch (error: unknown) {
            console.error("chat image cleanup failed", {
              serverId: this.room.id(),
              imageId,
              error,
            });
          }
        }),
      Promise.resolve(),
    );
    if (this.chat.hasPendingImageCleanup()) await this.ensureAlarmArmed(Date.now());
  }

  private async cleanupSoundAssets(): Promise<void> {
    await pendingSoundAssetCleanup(this.ctx.storage.sql).reduce<Promise<void>>(
      (chain, r2Key) =>
        chain.then(async () => {
          try {
            await this.env.MEDIA.delete(r2Key);
            // Keep the queue row until both R2 and the storage inventory agree. A later alarm retries
            // the same idempotent deletion if either service is temporarily unavailable.
            await removeMediaObject(this.env.DB, r2Key);
            completeSoundAssetCleanup(this.ctx.storage.sql, r2Key);
          } catch (error: unknown) {
            console.error("sound asset cleanup failed", {
              serverId: this.room.id(),
              r2Key,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      Promise.resolve(),
    );
    if (pendingSoundAssetCleanup(this.ctx.storage.sql).length > 0) {
      await this.ensureAlarmArmed(Date.now());
    }
  }

  private async cleanupMarketAssets(): Promise<void> {
    await Promise.all(
      this.market.pendingAssetCleanup().map(async (r2Key) => {
        try {
          await this.env.MEDIA.delete(r2Key);
          await removeMediaObject(this.env.DB, r2Key);
          this.market.completeAssetCleanup(r2Key);
        } catch (error: unknown) {
          console.error("market asset cleanup failed", {
            serverId: this.room.id(),
            r2Key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    if (this.market.pendingAssetCleanup().length > 0) {
      await this.ensureAlarmArmed(Date.now());
    }
  }

  private marketError(code: ErrorCode): Response {
    const status =
      code === "not_found"
        ? 404
        : code === "not_admin" || code === "forbidden"
          ? 403
          : code === "rate_limited"
            ? 429
            : code === "market_sold" ||
                code === "market_item_changed" ||
                code === "market_item_frozen" ||
                code === "market_icon_not_owned" ||
                code === "insufficient_points"
              ? 409
              : 400;
    return Response.json({ error: code }, { status });
  }

  private async cleanupStreamPreviews(): Promise<void> {
    const pending = await this.room.pendingStreamPreviewCleanup();
    await Promise.all(
      pending.map(async (previewId) => {
        const key = `${this.room.id()}/stream-previews/${previewId}.webp`;
        try {
          await this.env.MEDIA.delete(key);
          // Keep the queue entry until BOTH stores agree. If D1 is temporarily unavailable the alarm
          // repeats the idempotent R2 delete and inventory removal instead of silently losing cleanup.
          await removeMediaObject(this.env.DB, key);
          await this.room.completeStreamPreviewCleanup(previewId);
        } catch (error: unknown) {
          console.error("stream preview cleanup failed", {
            serverId: this.room.id(),
            previewId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    if (await this.room.hasPendingStreamPreviewCleanup()) {
      await this.ensureAlarmArmed(Date.now());
    }
  }

  // Arms the alarm only if none is scheduled (never pushes an in-flight ghost-close window forward).
  private async ensureAlarmArmed(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + this.alarmIntervalMs());
    }
  }

  private async ensureAlarmNoLaterThan(deadline: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > deadline) await this.ctx.storage.setAlarm(deadline);
  }

  private async scheduleVoiceDisconnect(userId: string, now: number): Promise<void> {
    const disconnects = (await this.ctx.storage.get<VoiceDisconnects>(VOICE_DISCONNECTS_KEY)) ?? {};
    const deadline = now + VOICE_RECONNECT_GRACE_MS;
    disconnects[userId] = deadline;
    await this.ctx.storage.put(VOICE_DISCONNECTS_KEY, disconnects);
    await this.ensureAlarmNoLaterThan(deadline);
  }

  private hasMediaSocket(userId: string, exclude?: WebSocket): boolean {
    return this.room.socketsOf(userId).some((socket) => {
      if (socket === exclude) return false;
      const attachment: ConnAttachment | null = socket.deserializeAttachment();
      return attachment?.mediaResume === true;
    });
  }

  private async cancelVoiceDisconnect(userId: string): Promise<void> {
    const disconnects = await this.ctx.storage.get<VoiceDisconnects>(VOICE_DISCONNECTS_KEY);
    if (disconnects === undefined || disconnects[userId] === undefined) return;
    delete disconnects[userId];
    await this.writeVoiceDisconnects(disconnects);
  }

  private async writeVoiceDisconnects(disconnects: VoiceDisconnects): Promise<void> {
    if (Object.keys(disconnects).length === 0) {
      await this.ctx.storage.delete(VOICE_DISCONNECTS_KEY);
      return;
    }
    await this.ctx.storage.put(VOICE_DISCONNECTS_KEY, disconnects);
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

  // Sliding-window screenshot gate (§ screenshots / LIMITS.rateScreenshotsPerMin): true when the user
  // has captured fewer than the cap in the last minute. Read-only — the timestamp is recorded only after
  // a successful create (`recordScreenshot`), so a rejected capture never consumes budget.
  private allowScreenshot(userId: string, now: number): boolean {
    const cutoff = now - 60_000;
    const recent = (this.screenshotTimes.get(userId) ?? []).filter((t) => t > cutoff);
    this.screenshotTimes.set(userId, recent);
    return recent.length < LIMITS.rateScreenshotsPerMin;
  }

  private recordScreenshot(userId: string, now: number): void {
    const recent = this.screenshotTimes.get(userId) ?? [];
    recent.push(now);
    this.screenshotTimes.set(userId, recent);
  }

  private rejectFrame(ws: WebSocket): void {
    this.room.send(ws, { t: "error", code: "bad_message" });
    ws.close(CLOSE_PROTOCOL_VIOLATION, "bad_message");
  }

  private notImplemented(ws: WebSocket): void {
    this.room.send(ws, { t: "error", code: "not_implemented" });
  }
}
