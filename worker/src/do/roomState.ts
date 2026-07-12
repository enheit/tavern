import { z } from "zod";
import { DEFAULT_SCREEN_PRESET, LIMITS, PresetIdSchema, serverMessageSchema } from "@tavern/shared";
import type {
  CostStatus,
  ErrorCode,
  Member,
  MemberInit,
  Presence,
  PresetId,
  RecordingState,
  ServerMessage,
  StreamInfo,
  UserProfile,
  VoiceMember,
  VoiceState,
} from "@tavern/shared";
import { rowToMember } from "./sql";
import type { CostMeter } from "./costMeter";

// The per-connection identity stashed on the hibernatable WebSocket (ids only, 16 KB cap — §A2/§6.2).
export type ConnAttachment = { userId: string; connId: string; hello: boolean };

// The server metadata snapshot the DO serves in `hello.ok` — written in full by /internal/member-join,
// `nickname` patched by /internal/server-updated. Persisted in ctx.storage KV under `meta`.
export type RoomMeta = { id: string; nickname: string; adminUserId: string };

// A single-use WS auth ticket record (A4). Stored in ctx.storage KV under `ticket:{uuid}`.
type TicketRecord = { userId: string; expiresAt: number };

// Track-name grammar kinds (§7.1). `mic`/`screenAudio` are audio-only; `screen`/`cam` are the
// StreamInfo-representable video kinds that get a stream.added broadcast.
const rtcKindSchema = z.enum(["mic", "screen", "screenAudio", "cam"]);
export type RtcKind = z.infer<typeof rtcKindSchema>;

// The `/internal/rtc/authorize` op contract (§6.1, zod-validated at the DO ingress). The Worker route
// builds this from the client body (deriving `kind` from the track-name grammar); the DO is the sole
// authority on voice membership (G1), the share cap (G4), and pull grants + the egress kill (G5).
export const rtcAuthorizeReqSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("session.new"), userId: z.string(), sessionId: z.string() }),
  z.object({
    op: z.literal("publish"),
    userId: z.string(),
    sessionId: z.string(),
    tracks: z.array(
      z.object({ trackName: z.string(), kind: rtcKindSchema, preset: PresetIdSchema.optional() }),
    ),
  }),
  z.object({
    op: z.literal("pull"),
    userId: z.string(),
    tracks: z.array(
      z.object({ trackName: z.string(), preferredRid: z.enum(["h", "l"]).optional() }),
    ),
  }),
  z.object({
    op: z.literal("layer"),
    userId: z.string(),
    trackName: z.string(),
    preferredRid: z.enum(["h", "l"]),
  }),
  z.object({ op: z.literal("close"), userId: z.string(), trackNames: z.array(z.string()) }),
]);
export type RtcAuthorizeReq = z.infer<typeof rtcAuthorizeReqSchema>;

// `publisherSessions` maps each pulled trackName → its publisher's SFU sessionId so the route can build
// the SFU RemoteTrackReqs — the client never learns another user's sessionId (only what the SFU echoes).
export type RtcAuthorizeRes =
  | { ok: true; publisherSessions?: Record<string, string> }
  | { ok: false; error: ErrorCode };

// One registered SFU track. `preset`/`hasAudio` are set for the video kinds (drive the StreamInfo +
// the cost meter's per-pull bitrate); mic/screenAudio omit them.
type RtcTrackReg = {
  userId: string;
  sessionId: string;
  kind: RtcKind;
  preset?: PresetId;
  hasAudio?: boolean;
};

// The per-room RTC registry (KV `rtc`): SFU session ownership, published tracks (for pull resolution +
// the G4 cap), and viewer watch grants (viewerId → trackName → charged rid; seeded by WS watch.start,
// S8.2). Read/written on each authorize (no in-memory mirror — it is not in the sync hello snapshot).
export type RtcRegistry = {
  sessions: Record<string, string>;
  tracks: Record<string, RtcTrackReg>;
  grants: Record<string, Record<string, "h" | "l">>;
};

type HelloOk = Extract<ServerMessage, { t: "hello.ok" }>;

// Non-null narrow without `!` (§9.1): a value a caller structurally guarantees.
function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// UserProfile projection of a cached Member (drops presence/isAdmin/joinedAt; keeps optional avatar).
function toProfile(member: Member): UserProfile {
  return {
    userId: member.userId,
    username: member.username,
    displayName: member.displayName,
    color: member.color,
    ...(member.avatarKey === undefined ? {} : { avatarKey: member.avatarKey }),
  };
}

// Owns all per-room state: tickets, sockets, the member-profile cache, presence derivation, the
// broadcast fan-out, and the `hello.ok` snapshot. The ServerRoom DO holds ONLY WS lifecycle + routing.
export class RoomState {
  // In-memory cache of the ctx.storage KV `meta` value, loaded once in `load()` (called from the DO's
  // blockConcurrencyWhile) so `helloSnapshot` stays synchronous. Kept in sync on every meta write.
  private meta: RoomMeta | null = null;

  // In-memory cache of the ctx.storage KV `voice` value — hibernation-safe truth lives in KV (§S3.4
  // task 1, STOP: never in-memory only), this mirror keeps `helloSnapshot`/`voiceState` synchronous.
  // Loaded in `load()`, re-read by `loadVoice()` (the alarm calls it to pick up external writes), and
  // replaced on every voice mutation (each mutator then persisted via `persistVoice()` by the caller).
  private voice: VoiceState = { members: [], sessionStartedAt: null };

  // In-memory mirror of the ctx.storage KV `status` value — the free-text shared server status any
  // member may set (§ header status). Loaded in `load()`, kept synchronous for `helloSnapshot`, and
  // replaced + persisted on every `setStatus`. Last write wins (a single KV value, no merge).
  private status = "";

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  // Loads the persisted room meta + voice state into memory (call once from blockConcurrencyWhile).
  async load(): Promise<void> {
    this.meta = (await this.ctx.storage.get<RoomMeta>("meta")) ?? null;
    this.status = (await this.ctx.storage.get<string>("status")) ?? "";
    await this.loadVoice();
  }

  // Re-reads the persisted voice state into the in-memory mirror. Called from `load()` and from the
  // alarm (so a crash-leftover seeded straight into KV is reconciled from KV, not a stale mirror).
  async loadVoice(): Promise<void> {
    this.voice = (await this.ctx.storage.get<VoiceState>("voice")) ?? {
      members: [],
      sessionStartedAt: null,
    };
  }

  // Persists the current in-memory voice state to KV. Callers of a voice mutator await this next (the
  // mutators stay synchronous per the pinned signatures; the DO output gate makes the write durable).
  async persistVoice(): Promise<void> {
    await this.ctx.storage.put("voice", this.voice);
  }

  async createTicket(userId: string): Promise<string> {
    const ticket = crypto.randomUUID();
    const record: TicketRecord = { userId, expiresAt: Date.now() + LIMITS.wsTicketTtlMs };
    await this.ctx.storage.put(`ticket:${ticket}`, record);
    return ticket;
  }

  // Single-use: deletes on read, then rejects an expired record. Returns the bound userId or null.
  async consumeTicket(ticket: string): Promise<string | null> {
    const key = `ticket:${ticket}`;
    const record = await this.ctx.storage.get<TicketRecord>(key);
    if (record === undefined) return null;
    await this.ctx.storage.delete(key);
    if (record.expiresAt < Date.now()) return null;
    return record.userId;
  }

  async setMeta(meta: RoomMeta): Promise<void> {
    await this.ctx.storage.put("meta", meta);
    this.meta = meta;
  }

  // §9.5 rebuild-from-D1: ticket issuance ships the Worker-read D1 truth on every call. Fill ONLY
  // the missing pieces — meta when the create/join-time member-join seed never landed (its failure
  // is deliberately non-fatal) and the caller's member row when the profile cache is empty. A live
  // cache is never overwritten, so an in-flight stale seed can't undo a kick or a rename.
  async seedIfMissing(member: MemberInit, meta: RoomMeta): Promise<void> {
    if (this.meta === null) await this.setMeta(meta);
    if (!this.hasMember(member.userId)) this.upsertMember(member);
  }

  // The server's stable id (from the cached meta), used by RecordingsModule to build R2 keys
  // (`recordings/{serverId}/…`, §5.3). Null before the first member-join seeds meta.
  serverId(): string | null {
    return this.meta?.id ?? null;
  }

  async patchNickname(nickname: string): Promise<void> {
    const current = this.meta;
    if (current === null) return;
    const next: RoomMeta = { ...current, nickname };
    await this.ctx.storage.put("meta", next);
    this.meta = next;
  }

  // ---- Shared server status (§ header status). Any member may set it (no admin gate); last write
  // wins. `setStatus` persists to KV + updates the mirror; the caller broadcasts `status.updated`.

  statusValue(): string {
    return this.status;
  }

  async setStatus(text: string): Promise<void> {
    this.status = text;
    await this.ctx.storage.put("status", text);
  }

  // ---- Voice (FR-18/24/26). Mutators are synchronous (in-memory mirror + SQLite); the caller awaits
  // `persistVoice()` right after. `voice_sessions` records history rows (§5.2, FR-13 `channel_id='main'`).

  voiceState(): VoiceState {
    return this.voice;
  }

  // Idempotent join: a repeat from the same user returns the current snapshot unchanged. The first
  // member opens a `voice_sessions` row + starts the session timer (FR-24).
  voiceJoin(userId: string, now: number): VoiceState {
    if (this.voice.members.some((m) => m.userId === userId)) return this.voice;
    const wasEmpty = this.voice.members.length === 0;
    const member: VoiceMember = { userId, muted: false, deafened: false };
    this.voice = {
      members: [...this.voice.members, member],
      sessionStartedAt: wasEmpty ? now : this.voice.sessionStartedAt,
    };
    if (wasEmpty) {
      this.ctx.storage.sql.exec(
        `INSERT INTO voice_sessions (channel_id, started_at) VALUES ('main', ?)`,
        now,
      );
    }
    return this.voice;
  }

  // Removes a member; when the room empties, closes the open `voice_sessions` row and stops the timer.
  // `closedSession` tells the caller the session just ended (last member left).
  voiceLeave(userId: string, now: number): { snapshot: VoiceState; closedSession: boolean } {
    if (!this.voice.members.some((m) => m.userId === userId)) {
      return { snapshot: this.voice, closedSession: false };
    }
    const members = this.voice.members.filter((m) => m.userId !== userId);
    const nowEmpty = members.length === 0;
    this.voice = { members, sessionStartedAt: nowEmpty ? null : this.voice.sessionStartedAt };
    if (nowEmpty) {
      this.ctx.storage.sql.exec(
        `UPDATE voice_sessions SET ended_at = ? WHERE ended_at IS NULL`,
        now,
      );
    }
    return { snapshot: this.voice, closedSession: nowEmpty };
  }

  // Relays a member's self mute/deafen flags (FR-26; no server-side audio semantics). No-op if the
  // user is not currently in voice.
  setVoiceFlags(userId: string, flags: { muted: boolean; deafened: boolean }): VoiceState {
    if (!this.voice.members.some((m) => m.userId === userId)) return this.voice;
    this.voice = {
      ...this.voice,
      members: this.voice.members.map((m) =>
        // Spread keeps micSeq — rebuilding the literal here silently reset every peer's re-pull
        // cursor on any mute toggle.
        m.userId === userId ? { ...m, muted: flags.muted, deafened: flags.deafened } : m,
      ),
    };
    return this.voice;
  }

  // A mic track (re)registered for `userId` (op:publish below): bump the member's micSeq so peers
  // holding a pull of the PREVIOUS mic session re-pull the new one, and give first-time publishes a
  // "mic is now pullable" voice.state signal (the join-time voice.state races the REST publish —
  // §7.1 — and the client's bounded retry alone gave up before slow mic acquisitions finished).
  // Returns null when the user is not in voice (authorize already guarantees they are).
  private bumpMicSeq(userId: string): VoiceState | null {
    if (!this.voice.members.some((m) => m.userId === userId)) return null;
    this.voice = {
      ...this.voice,
      members: this.voice.members.map((m) =>
        m.userId === userId ? { ...m, micSeq: (m.micSeq ?? 0) + 1 } : m,
      ),
    };
    return this.voice;
  }

  // ---- RTC registry + authorize (§6.1 /internal/rtc/authorize, §8 G1/G4/G5). Persisted in KV `rtc`;
  // read/written per authorize (not in the sync hello snapshot). Voice membership is re-read from KV
  // (`voiceMemberIds`) so a test/producer that seeds voice straight into storage is honored.

  private async readRtc(): Promise<RtcRegistry> {
    const stored = await this.ctx.storage.get<RtcRegistry>("rtc");
    if (stored === undefined) return { sessions: {}, tracks: {}, grants: {} };
    return {
      sessions: { ...stored.sessions },
      tracks: { ...stored.tracks },
      grants: { ...stored.grants },
    };
  }

  private async writeRtc(reg: RtcRegistry): Promise<void> {
    await this.ctx.storage.put("rtc", reg);
  }

  private async voiceMemberIds(): Promise<string[]> {
    const voice = await this.ctx.storage.get<VoiceState>("voice");
    return (voice?.members ?? []).map((m) => m.userId);
  }

  // Read-only registry snapshot (tests + S8.x inspection).
  async rtcSnapshot(): Promise<RtcRegistry> {
    return this.readRtc();
  }

  // Grants a viewer the right to pull a stream (G1) at a charged rid — seeded by WS watch.start (S8.2)
  // and by tests. The pull authorize checks this; the cost meter charges the recorded rid.
  async rtcAddGrant(viewerId: string, trackName: string, rid: "h" | "l"): Promise<void> {
    const reg = await this.readRtc();
    const grants = reg.grants[viewerId] ?? {};
    grants[trackName] = rid;
    reg.grants[viewerId] = grants;
    await this.writeRtc(reg);
  }

  // watch.stop / release (S8.4): drop ONE viewer's grant for a track (G1 hygiene — a subsequent
  // un-watched pull is then denied). No-op when the grant is absent.
  async rtcRemoveGrant(viewerId: string, trackName: string): Promise<void> {
    const reg = await this.readRtc();
    const grants = reg.grants[viewerId];
    if (grants === undefined || grants[trackName] === undefined) return;
    delete grants[trackName];
    if (Object.keys(grants).length === 0) delete reg.grants[viewerId];
    await this.writeRtc(reg);
  }

  // FR-27 on-the-fly preset switch (S8.4): update the registry preset for a SCREEN track the caller
  // OWNS, so a watcher that STARTS after the switch is metered at the new bitrate (open watches are
  // repriced separately by the cost meter). Returns false when the track is unknown, not owned by
  // `userId`, or not a screen (the webcam preset is fixed) — the caller answers bad_message + skips.
  async rtcRepriceStream(userId: string, trackName: string, preset: PresetId): Promise<boolean> {
    const reg = await this.readRtc();
    const track = reg.tracks[trackName];
    if (track === undefined || track.userId !== userId || track.kind !== "screen") return false;
    reg.tracks[trackName] = { ...track, preset };
    await this.writeRtc(reg);
    return true;
  }

  // Test-only (S8.5, reachable ONLY via the mock-SFU-gated /api/__test route): register `count`
  // synthetic active SCREEN shares in the registry so an e2e can exercise the G4 concurrent-share cap
  // (§8 G4) without publishing real media. Each synthetic share gets a unique owner/session/track name;
  // none broadcasts stream.added (no live UI depends on them — only the publish cap counts reg.tracks
  // screens). Returns the resulting total registered screen count.
  async rtcSeedShares(count: number): Promise<number> {
    const reg = await this.readRtc();
    for (let i = 0; i < count; i += 1) {
      const id = crypto.randomUUID();
      reg.tracks[`screen:seed-${id}:1`] = {
        userId: `seed-${id}`,
        sessionId: `seed-session-${id}`,
        kind: "screen",
        preset: DEFAULT_SCREEN_PRESET,
        hasAudio: false,
      };
    }
    await this.writeRtc(reg);
    return Object.values(reg.tracks).filter((t) => t.kind === "screen").length;
  }

  // § watching indicator: flatten the grants registry into (viewer, trackName) pairs — only for
  // tracks that still exist (a grant may outlive its stream until the viewer's watch.stop lands) —
  // and broadcast the full `watch.state` snapshot. Called after every grant/track mutation.
  async broadcastWatching(at: number): Promise<void> {
    const reg = await this.readRtc();
    const watching: Array<{ userId: string; trackName: string }> = [];
    for (const [viewerId, grants] of Object.entries(reg.grants)) {
      for (const name of Object.keys(grants)) {
        if (reg.tracks[name] !== undefined) watching.push({ userId: viewerId, trackName: name });
      }
    }
    this.broadcast({ t: "watch.state", watching, at });
  }

  // Resolve a watchable video track (screen/cam) → its publisher + current preset, for watch.start's
  // grant seed + meter openWatch. Null for an unknown track or a non-video kind (mic/screenAudio).
  async rtcWatchable(trackName: string): Promise<{ streamerId: string; preset: PresetId } | null> {
    const reg = await this.readRtc();
    const track = reg.tracks[trackName];
    if (track === undefined || (track.kind !== "screen" && track.kind !== "cam")) return null;
    return { streamerId: track.userId, preset: track.preset ?? DEFAULT_SCREEN_PRESET };
  }

  // The StreamInfo for a published track, or null for the non-video kinds. mic/screenAudio are NOT
  // StreamInfo (the pinned schema requires kind ∈ {screen,webcam} + a preset; mics ride voice.state) —
  // they register for pull resolution but never broadcast stream.added.
  private streamInfoFor(
    trackName: string,
    kind: RtcKind,
    preset: PresetId | undefined,
    userId: string,
    hasScreenAudio: boolean,
  ): StreamInfo | null {
    if (kind === "screen") {
      return {
        trackName,
        kind: "screen",
        userId,
        hasAudio: hasScreenAudio,
        preset: preset ?? DEFAULT_SCREEN_PRESET,
      };
    }
    if (kind === "cam") {
      // Webcam is the fixed 720p30 h-layer (App-D); no stream audio.
      return { trackName, kind: "webcam", userId, hasAudio: false, preset: "720p30" };
    }
    return null;
  }

  // The active watchable streams (screen/cam) for the `hello.ok` snapshot (§6.2): every video track
  // still registered in the RTC registry, rebuilt into StreamInfo via the SAME mapping the live
  // `stream.added` broadcast uses (`hasAudio` read straight from the registered track, baked at publish
  // in `rtcAuthorize` op:publish). This is how a LATE joiner or a RECONNECTING client learns about a
  // share that started BEFORE they connected — `stream.added` fires once, at publish time, so a client
  // absent then would otherwise never see it. mic/screenAudio are audio-only (streamInfoFor → null).
  async activeStreams(): Promise<StreamInfo[]> {
    const reg = await this.readRtc();
    const streams: StreamInfo[] = [];
    for (const [trackName, track] of Object.entries(reg.tracks)) {
      const info = this.streamInfoFor(
        trackName,
        track.kind,
        track.preset,
        track.userId,
        track.hasAudio ?? false,
      );
      if (info !== null) streams.push(info);
    }
    return streams;
  }

  // The single authorize entry (dispatched from ServerRoom's /internal/rtc/authorize). Ordering pins
  // per §6.1 task 5. `meter` gates the pull kill switch (G5) + reprices on layer.
  async rtcAuthorize(req: RtcAuthorizeReq, meter: CostMeter, at: number): Promise<RtcAuthorizeRes> {
    const inVoice = (await this.voiceMemberIds()).includes(req.userId);
    const reg = await this.readRtc();
    switch (req.op) {
      case "session.new": {
        if (!inVoice) return { ok: false, error: "not_in_voice" };
        reg.sessions[req.sessionId] = req.userId;
        await this.writeRtc(reg);
        return { ok: true };
      }
      case "publish": {
        if (!inVoice) return { ok: false, error: "not_in_voice" };
        // G4: server-wide concurrent screen-share cap.
        const currentScreens = Object.values(reg.tracks).filter((t) => t.kind === "screen").length;
        const newScreens = req.tracks.filter((t) => t.kind === "screen").length;
        if (currentScreens + newScreens > LIMITS.maxConcurrentScreenShares) {
          return { ok: false, error: "share_cap" };
        }
        const hasScreenAudio = req.tracks.some((t) => t.kind === "screenAudio");
        for (const t of req.tracks) {
          const preset =
            t.preset ??
            (t.kind === "screen" ? DEFAULT_SCREEN_PRESET : t.kind === "cam" ? "720p30" : undefined);
          reg.tracks[t.trackName] = {
            userId: req.userId,
            sessionId: req.sessionId,
            kind: t.kind,
            ...(preset === undefined ? {} : { preset }),
            ...(t.kind === "screen" || t.kind === "cam"
              ? { hasAudio: t.kind === "screen" ? hasScreenAudio : false }
              : {}),
          };
        }
        await this.writeRtc(reg);
        // Registration success → stream.added for the video kinds. A mic registration broadcasts a
        // fresh voice.state with the member's micSeq bumped: peers use it both as the "mic is now
        // pullable" signal (first publish — the join-time broadcast raced this registration) and as
        // the re-pull trigger when a rejoin/recovery re-registered mic:{uid} under a NEW SFU session
        // (existing pulls point at the dead one; nothing else ever tells the peers).
        if (req.tracks.some((t) => t.kind === "mic")) {
          const snapshot = this.bumpMicSeq(req.userId);
          if (snapshot !== null) {
            await this.persistVoice();
            this.broadcast({ t: "voice.state", voice: snapshot, at });
          }
        }
        for (const t of req.tracks) {
          const stream = this.streamInfoFor(
            t.trackName,
            t.kind,
            t.preset,
            req.userId,
            hasScreenAudio,
          );
          if (stream !== null) this.broadcast({ t: "stream.added", stream, at });
        }
        return { ok: true };
      }
      case "pull": {
        const publisherSessions: Record<string, string> = {};
        for (const t of req.tracks) {
          const reg2 = reg.tracks[t.trackName];
          if (reg2 === undefined) return { ok: false, error: "pull_denied" };
          if (reg2.kind === "mic") {
            // Voice mics auto-subscribe — any voice member may pull them, no grant (G1).
            if (!inVoice) return { ok: false, error: "not_in_voice" };
          } else {
            // Opt-in media: needs an explicit watch grant (G1) and the egress kill (G5) allows it. A
            // screen loopback-audio companion (screenAudio:{uid}:{n}) rides its video's grant — you
            // watch the screen, you hear it (§7.1); watch.start only grants the video track name.
            const grantTrack =
              reg2.kind === "screenAudio"
                ? t.trackName.replace(/^screenAudio:/, "screen:")
                : t.trackName;
            if (reg.grants[req.userId]?.[grantTrack] === undefined) {
              return { ok: false, error: "pull_denied" };
            }
            if (meter.isBlocked(at)) return { ok: false, error: "cost_cap" };
          }
          publisherSessions[t.trackName] = reg2.sessionId;
        }
        return { ok: true, publisherSessions };
      }
      case "layer": {
        const grants = reg.grants[req.userId];
        if (grants !== undefined && grants[req.trackName] !== undefined) {
          grants[req.trackName] = req.preferredRid;
          await this.writeRtc(reg);
          await meter.setWatcherLayer(req.userId, req.trackName, req.preferredRid, at);
        }
        return { ok: true };
      }
      case "close": {
        // Unregister the caller's named tracks + broadcast stream.removed for the video ones (the
        // compensating undo of a failed publish). Grants + meter for the caller are swept on disconnect
        // via rtcCleanupFor. Only the owner may close their own tracks.
        let changed = false;
        for (const name of req.trackNames) {
          const reg2 = reg.tracks[name];
          if (reg2 === undefined || reg2.userId !== req.userId) continue;
          delete reg.tracks[name];
          changed = true;
          if (reg2.kind === "screen" || reg2.kind === "cam") {
            this.broadcast({ t: "stream.removed", trackName: name, at });
          }
        }
        if (changed) {
          await this.writeRtc(reg);
          // Closing a track invalidates its watchers' pairs — refresh the watch.state snapshot
          // immediately (the viewers' own watch.stop frames land later).
          await this.broadcastWatching(at);
        }
        return { ok: true };
      }
      default:
        return { ok: false, error: "bad_request" };
    }
  }

  // Disconnect cleanup (§S3.4 leave path): drop the user's SFU sessions + published tracks (broadcast
  // stream.removed for video), release their watch grants, and flush their open meter watches. The SFU
  // GCs the dead session on its own (~30s), so no SFU call is needed here.
  async rtcCleanupFor(userId: string, meter: CostMeter, at: number): Promise<void> {
    const reg = await this.readRtc();
    let changed = false;
    for (const [sessionId, owner] of Object.entries(reg.sessions)) {
      if (owner === userId) {
        delete reg.sessions[sessionId];
        changed = true;
      }
    }
    for (const [name, track] of Object.entries(reg.tracks)) {
      if (track.userId !== userId) continue;
      delete reg.tracks[name];
      changed = true;
      if (track.kind === "screen" || track.kind === "cam") {
        this.broadcast({ t: "stream.removed", trackName: name, at });
      }
    }
    if (reg.grants[userId] !== undefined) {
      delete reg.grants[userId];
      changed = true;
    }
    if (changed) {
      await this.writeRtc(reg);
      // Their grants (and/or their published tracks) are gone — refresh everyone's watch.state.
      await this.broadcastWatching(at);
    }
    await meter.closeWatchesForViewer(userId, at);
  }

  upsertMember(member: MemberInit): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO members (user_id, username, display_name, color, avatar_key, is_admin, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username, display_name = excluded.display_name,
         color = excluded.color, avatar_key = excluded.avatar_key,
         is_admin = excluded.is_admin, joined_at = excluded.joined_at`,
      member.userId,
      member.username,
      member.displayName,
      member.color,
      member.avatarKey ?? null,
      member.isAdmin ? 1 : 0,
      member.joinedAt,
    );
  }

  // Patches the cached profile columns (username/display_name/color/avatar_key) of an existing member.
  updateProfile(profile: UserProfile): void {
    this.ctx.storage.sql.exec(
      `UPDATE members SET username = ?, display_name = ?, color = ?, avatar_key = ? WHERE user_id = ?`,
      profile.username,
      profile.displayName,
      profile.color,
      profile.avatarKey ?? null,
      profile.userId,
    );
  }

  removeMember(userId: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM members WHERE user_id = ?`, userId);
  }

  hasMember(userId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT 1 AS one FROM members WHERE user_id = ? LIMIT 1`,
          userId,
        )
        .toArray().length > 0
    );
  }

  listMembers(): Member[] {
    return this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT user_id, username, display_name, color, avatar_key, is_admin, joined_at
         FROM members ORDER BY joined_at ASC`,
      )
      .toArray()
      .map((row) => rowToMember(row, this.presenceOf(String(row["user_id"]))));
  }

  // Presence derives purely from live hibernatable sockets (no in-memory map — hibernation-safe).
  // 'in-voice' is reserved for S3.4; v1 presence is online iff the user has ≥1 completed-handshake socket.
  presenceOf(userId: string): Presence {
    return this.helloSocketCount(userId) > 0 ? "online" : "offline";
  }

  // Every socket bound to the user (hello'd or not) — used by /internal/kick to evict all of them.
  socketsOf(userId: string): WebSocket[] {
    const result: WebSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (att !== null && att.userId === userId) result.push(ws);
    }
    return result;
  }

  send(ws: WebSocket, msg: ServerMessage): void {
    ws.send(JSON.stringify(serverMessageSchema.parse(msg)));
  }

  // Validates the frame OUTBOUND (§9.8 applies both directions), then fans it to every hello'd socket.
  // `except` takes an array so a sender's OTHER sockets are all excluded (chat echo, S3.2).
  broadcast(
    msg: ServerMessage,
    opts?: { except?: WebSocket | WebSocket[]; toUserId?: string },
  ): void {
    const data = JSON.stringify(serverMessageSchema.parse(msg));
    const except =
      opts?.except === undefined ? [] : Array.isArray(opts.except) ? opts.except : [opts.except];
    const toUserId = opts?.toUserId;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (att === null || !att.hello) continue;
      if (except.includes(ws)) continue;
      if (toUserId !== undefined && att.userId !== toUserId) continue;
      ws.send(data);
    }
  }

  helloSnapshot(
    userId: string,
    lastMessageId: number,
    costStatus: CostStatus,
    recording: RecordingState,
    streams: StreamInfo[],
  ): HelloOk {
    const meta = invariant(this.meta, "room meta not initialized");
    const members = this.listMembers();
    const selfMember = invariant(
      members.find((m) => m.userId === userId),
      "self not present in member cache",
    );
    return {
      t: "hello.ok",
      self: toProfile(selfMember),
      serverMeta: meta,
      members,
      // Live voice snapshot (S3.4) + live cost meter (S7.1) + live recording pointer (S9.3, from
      // RecordingsModule.state) + the active streams (S8), passed in by the caller from
      // `activeStreams()` so a late joiner / reconnect learns in-progress shares. lastMessageId from
      // ChatModule (S3.2).
      voice: this.voice,
      streams,
      recording,
      status: this.status,
      lastMessageId,
      costStatus,
    };
  }

  // Presence transition on a socket completing its handshake: broadcast `online` only on 0→1.
  presenceOnHello(ws: WebSocket, userId: string, at: number): void {
    if (this.helloSocketCount(userId, ws) === 0) {
      this.broadcast({ t: "presence.update", userId, presence: "online", at });
    }
  }

  // Presence transition on disconnect: broadcast `offline` only on 1→0, and only while the user is
  // still a cached member (a kick already removed them + emitted member.left — no stray presence).
  presenceOnClose(ws: WebSocket, att: ConnAttachment, at: number): void {
    if (!att.hello) return;
    if (this.helloSocketCount(att.userId, ws) > 0) return;
    if (!this.hasMember(att.userId)) return;
    this.broadcast({ t: "presence.update", userId: att.userId, presence: "offline", at });
  }

  // Count of the user's completed-handshake sockets, optionally excluding one (the current event's ws).
  private helloSocketCount(userId: string, exclude?: WebSocket): number {
    let count = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const att = this.attachmentOf(ws);
      if (att !== null && att.hello && att.userId === userId) count += 1;
    }
    return count;
  }

  // The attachment is our own serialized ConnAttachment (trusted, DO-internal — §9.8 "internal call
  // sites trust types"); deserializeAttachment returns null only for a socket we never attached to.
  private attachmentOf(ws: WebSocket): ConnAttachment | null {
    const raw: ConnAttachment | null = ws.deserializeAttachment();
    return raw;
  }
}
