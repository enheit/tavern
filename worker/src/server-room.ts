import type { Env } from './index';
import { type TrackShape, pulledBitrateKbps } from './lib/bitrate';
// Single-source protocol types (ts-rs-generated from crates/protocol, S2.7).
import type { Member } from './protocol/Member';
import type { TrackInfo } from './protocol/TrackInfo';

// Per-server coordination Durable Object (PLAN §1): hibernatable WebSockets,
// presence, chat, and the unlock rate-limit counter. RTC/track registry + budget
// land in S2.6. Protocol v1 frames are `{ v:1, t, ... }` (defined in §1; the
// ts-rs-generated crates/protocol types are not wired yet — hand-written here).

const PROTOCOL_V = 1;
const UNLOCK_WINDOW_MS = 60_000; // §1: fixed 60 s window from first attempt.
const UNLOCK_MAX_ATTEMPTS = 5; // 6th attempt in window → 429.
const STALE_MS = 75_000; // presence older than this is swept.
const ALARM_MS = 60_000; // single periodic alarm (§1).
const NONCE_WINDOW_MS = 300_000; // chat.send nonce-dedup lookback.
const MAX_CONTENT = 2000; // message length cap (code points).
const HISTORY_MAX = 100; // chat.history limit ceiling.

type Attachment = { userId: string; connId: string };

export class ServerRoom {
  // Injectable clock (§1 Time): tests override via runInDurableObject.
  nowMs: () => number = () => Date.now();

  private sql: SqlStorage;
  private serverId: string | null = null;
  // Per-instance cache of granted channel unlocks (positive only — never cache a
  // miss, so a later unlock is picked up). Lost on hibernation, rebuilt from D1.
  private unlocked = new Set<string>();
  // rtc rate limit: per-user 1 s window (§1: 10/s/user). In-memory — a
  // hibernation reset only makes the limiter briefly lenient, which is fine.
  // ponytail: in-memory 1 s window; move to storage only if abuse matters.
  private rtcRate = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
      content TEXT NOT NULL, nonce TEXT, created_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_msg ON messages(channel_id, id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_msg_nonce ON messages(user_id, nonce)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS presence (
      user_id TEXT PRIMARY KEY, conn_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('online','voice')),
      channel_id TEXT, last_seen INTEGER NOT NULL)`);
    // Hydrate serverId before any message/alarm runs (survives hibernation).
    ctx.blockConcurrencyWhile(async () => {
      this.serverId = (await ctx.storage.get<string>('serverId')) ?? null;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/internal/unlock-rate') {
      const { userId, channelId } = await req.json<{ userId: string; channelId: string }>();
      return Response.json({ allowed: await this.consumeUnlockAttempt(userId, channelId) });
    }
    if (req.method === 'POST' && url.pathname === '/internal/profile') {
      const p = await req.json<{ userId: string; nickname: string; color: string; avatarKey: string | null }>();
      this.broadcast({ t: 'profile', ...p });
      return new Response(null, { status: 204 });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/internal/rtc/')) {
      return this.rtc(url.pathname.slice('/internal/rtc/'.length), await req.json<any>());
    }
    if (req.headers.get('Upgrade') === 'websocket') return this.handleUpgrade(req);
    return new Response('server-room', { status: 200 });
  }

  // ---- WebSocket lifecycle -------------------------------------------------

  private async handleUpgrade(req: Request): Promise<Response> {
    const userId = req.headers.get('X-Tavern-User');
    const serverId = req.headers.get('X-Tavern-Server');
    if (!userId || !serverId) return new Response('missing identity', { status: 401 });

    if (this.serverId !== serverId) {
      this.serverId = serverId;
      await this.ctx.storage.put('serverId', serverId);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const connId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, connId } satisfies Attachment);

    const now = this.nowMs();
    // Replace presence with the new conn FIRST so the superseded socket's close
    // (connId mismatch) is ignored — no spurious offline broadcast.
    this.sql.exec(
      `INSERT OR REPLACE INTO presence (user_id, conn_id, state, channel_id, last_seen)
       VALUES (?, ?, 'online', NULL, ?)`,
      userId,
      connId,
      now,
    );
    for (const s of this.ctx.getWebSockets()) {
      if (s === server) continue;
      const att = s.deserializeAttachment() as Attachment | null;
      if (att?.userId === userId) {
        try {
          s.close(4002, 'superseded');
        } catch {
          /* already closing */
        }
      }
    }

    await this.ensureAlarm();
    server.send(JSON.stringify(await this.helloPayload(userId)));
    this.broadcast({ t: 'presence', userId, state: 'online', channelId: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    let msg: any;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return this.sendError(ws, 'invalid', 'bad json');
    }
    this.touch(att);
    switch (msg.t) {
      case 'heartbeat':
        return void ws.send(JSON.stringify({ v: PROTOCOL_V, t: 'heartbeat.ok' }));
      case 'chat.send':
        return this.onChatSend(ws, att, msg);
      case 'chat.history':
        return this.onChatHistory(ws, att, msg);
      case 'voice.join':
        return this.onVoiceJoin(ws, att, msg);
      case 'voice.leave':
        return this.onVoiceLeave(att);
      default:
        return this.sendError(ws, 'invalid', 'unknown type');
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const row = this.presenceOf(att.userId);
    // Only the CURRENT connection going offline deletes presence + broadcasts.
    // A superseded socket (connId mismatch) is ignored (§1).
    if (row && row.conn_id === att.connId) {
      this.sql.exec('DELETE FROM presence WHERE user_id = ?', att.userId);
      // §1: on WS close — clear the track registry, broadcast tracks [], finalize accruals.
      await this.clearUserMedia(att.userId);
      this.broadcast({ t: 'presence', userId: att.userId, state: 'offline', channelId: null });
    }
  }

  // ---- message handlers ----------------------------------------------------

  private async onChatSend(ws: WebSocket, att: Attachment, msg: any): Promise<void> {
    const channelId = String(msg.channelId ?? '');
    const guard = await this.channelGuard(att.userId, channelId);
    if (guard.error) return this.sendError(ws, guard.error, 'channel');

    const content = String(msg.content ?? '').trim();
    if (!content || [...content].length > MAX_CONTENT) return this.sendError(ws, 'invalid', 'content');
    const nonce: string | null = typeof msg.nonce === 'string' ? msg.nonce : null;

    // Nonce dedup (survives hibernation — it's in SQLite). On a repeat, re-send
    // the existing message to the sender only, no new row.
    if (nonce) {
      const dup = [
        ...this.sql.exec(
          `SELECT id, channel_id, user_id, content, nonce, created_at FROM messages
           WHERE user_id = ? AND nonce = ? AND created_at > ? LIMIT 1`,
          att.userId,
          nonce,
          this.nowMs() - NONCE_WINDOW_MS,
        ),
      ];
      if (dup.length) return void ws.send(JSON.stringify(this.chatMsg(dup[0])));
    }

    const now = this.nowMs();
    const row = [
      ...this.sql.exec(
        `INSERT INTO messages (channel_id, user_id, content, nonce, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id, channel_id, user_id, content, nonce, created_at`,
        channelId,
        att.userId,
        content,
        nonce,
        now,
      ),
    ][0];
    this.broadcast(this.chatMsg(row));
  }

  private async onChatHistory(ws: WebSocket, att: Attachment, msg: any): Promise<void> {
    const channelId = String(msg.channelId ?? '');
    const guard = await this.channelGuard(att.userId, channelId);
    if (guard.error) return this.sendError(ws, guard.error, 'channel');

    const limit = Math.min(Math.max(1, Number(msg.limit) || 50), HISTORY_MAX);
    const beforeId: number | null = typeof msg.beforeId === 'number' ? msg.beforeId : null;
    const rows =
      beforeId == null
        ? [
            ...this.sql.exec(
              `SELECT id, channel_id, user_id, content, nonce, created_at FROM messages
               WHERE channel_id = ? ORDER BY id DESC LIMIT ?`,
              channelId,
              limit + 1,
            ),
          ]
        : [
            ...this.sql.exec(
              `SELECT id, channel_id, user_id, content, nonce, created_at FROM messages
               WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
              channelId,
              beforeId,
              limit + 1,
            ),
          ];
    const hasMore = rows.length > limit;
    ws.send(
      JSON.stringify({
        v: PROTOCOL_V,
        t: 'chat.history',
        channelId,
        messages: rows.slice(0, limit).map((r) => this.chatMsgBody(r)),
        hasMore,
      }),
    );
  }

  private async onVoiceJoin(ws: WebSocket, att: Attachment, msg: any): Promise<void> {
    const channelId = String(msg.channelId ?? '');
    const guard = await this.channelGuard(att.userId, channelId);
    if (guard.error) return this.sendError(ws, guard.error, 'channel');
    if (guard.kind !== 'voice') return this.sendError(ws, 'invalid', 'not a voice channel');

    // Update presence to voice/channel (full replace per user — a rejoin to a
    // different channel is just a new channelId; observers replace by userId).
    this.sql.exec(
      `UPDATE presence SET state = 'voice', channel_id = ?, last_seen = ? WHERE user_id = ?`,
      channelId,
      this.nowMs(),
      att.userId,
    );
    this.broadcast({ t: 'presence', userId: att.userId, state: 'voice', channelId });
  }

  private async onVoiceLeave(att: Attachment): Promise<void> {
    this.sql.exec(
      `UPDATE presence SET state = 'online', channel_id = NULL, last_seen = ? WHERE user_id = ?`,
      this.nowMs(),
      att.userId,
    );
    this.broadcast({ t: 'presence', userId: att.userId, state: 'online', channelId: null });
    // §1: on voice.leave — clear the track registry, broadcast tracks [], finalize accruals.
    await this.clearUserMedia(att.userId);
  }

  // ---- alarm (stale-presence sweep; budget flush lands in S2.6) -------------

  async alarm(): Promise<void> {
    const now = this.nowMs();
    const stale = [
      ...this.sql.exec<{ user_id: string }>(
        'SELECT user_id FROM presence WHERE last_seen < ?',
        now - STALE_MS,
      ),
    ];
    for (const { user_id } of stale) {
      this.sql.exec('DELETE FROM presence WHERE user_id = ?', user_id);
      // §1: on stale sweep — clear the track registry, broadcast tracks [], finalize accruals.
      await this.clearUserMedia(user_id);
      this.broadcast({ t: 'presence', userId: user_id, state: 'offline', channelId: null });
    }
    await this.flushBudget(); // §1 alarm job 2: budget flush + level re-eval
    // Keep the alarm alive while anyone is connected or present.
    if (this.ctx.getWebSockets().length > 0 || this.presenceCount() > 0) {
      await this.ctx.storage.setAlarm(now + ALARM_MS);
    }
  }

  // ---- helpers -------------------------------------------------------------

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) {
      await this.ctx.storage.setAlarm(this.nowMs() + ALARM_MS);
    }
  }

  private touch(att: Attachment): void {
    this.sql.exec(
      'UPDATE presence SET last_seen = ? WHERE user_id = ? AND conn_id = ?',
      this.nowMs(),
      att.userId,
      att.connId,
    );
  }

  private presenceOf(userId: string): { conn_id: string } | null {
    const rows = [...this.sql.exec<{ conn_id: string }>('SELECT conn_id FROM presence WHERE user_id = ?', userId)];
    return rows[0] ?? null;
  }

  private presenceCount(): number {
    return [...this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM presence')][0].n;
  }

  // Resolve a channel for an operation: must belong to this server (else invalid);
  // if password-locked, the user needs a channel_access row (else locked).
  private async channelGuard(
    userId: string,
    channelId: string,
  ): Promise<{ error?: 'invalid' | 'locked'; kind?: string }> {
    const ch = await this.env.DB.prepare(
      'SELECT server_id, kind, pw_hash FROM channels WHERE id = ?',
    )
      .bind(channelId)
      .first<{ server_id: string; kind: string; pw_hash: ArrayBuffer | null }>();
    if (!ch || ch.server_id !== this.serverId) return { error: 'invalid' };
    if (ch.pw_hash) {
      const key = `${userId}:${channelId}`;
      if (!this.unlocked.has(key)) {
        const acc = await this.env.DB.prepare(
          'SELECT 1 FROM channel_access WHERE user_id = ? AND channel_id = ?',
        )
          .bind(userId, channelId)
          .first();
        if (!acc) return { error: 'locked' };
        this.unlocked.add(key);
      }
    }
    return { kind: ch.kind };
  }

  private async helloPayload(userId: string): Promise<object> {
    const roster = await this.env.DB.prepare(
      `SELECT u.id, u.nickname, u.nickname_color, u.avatar_key FROM memberships m
       JOIN users u ON u.id = m.user_id WHERE m.server_id = ?`,
    )
      .bind(this.serverId)
      .all<{ id: string; nickname: string; nickname_color: string; avatar_key: string | null }>();
    const presence = [
      ...this.sql.exec<{ user_id: string; state: string; channel_id: string | null }>(
        'SELECT user_id, state, channel_id FROM presence',
      ),
    ].map((r) => ({ userId: r.user_id, state: r.state, channelId: r.channel_id }));
    return {
      v: PROTOCOL_V,
      t: 'hello.ok',
      userId,
      roster: roster.results.map(
        (u): Member => ({
          userId: u.id,
          nickname: u.nickname,
          color: u.nickname_color,
          avatarKey: u.avatar_key,
        }),
      ),
      presence,
      tracks: await this.allTracks(),
      budget: { level: await this.budgetLevel(), estMbps: 0, monthGb: 0 },
    };
  }

  private chatMsgBody(r: any) {
    return {
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      content: r.content,
      nonce: r.nonce ?? null,
      createdAt: r.created_at,
    };
  }

  private chatMsg(r: any) {
    return { v: PROTOCOL_V, t: 'chat.msg', ...this.chatMsgBody(r) };
  }

  private broadcast(payload: object): void {
    const frame = JSON.stringify({ v: PROTOCOL_V, ...payload });
    for (const s of this.ctx.getWebSockets()) {
      try {
        s.send(frame);
      } catch {
        /* socket closing */
      }
    }
  }

  private sendError(ws: WebSocket, code: string, msg: string): void {
    ws.send(JSON.stringify({ v: PROTOCOL_V, t: 'error', code, msg }));
  }

  // ---- RTC signaling (§1 Media-signaling) ----------------------------------

  private async rtc(op: string, b: any): Promise<Response> {
    if (b.serverId && this.serverId !== b.serverId) {
      this.serverId = b.serverId;
      await this.ctx.storage.put('serverId', b.serverId);
    }
    if (!this.rtcAllowed(b.userId)) return Response.json({ code: 'rate_limited' }, { status: 429 });
    switch (op) {
      case 'session':
        return this.rtcSession(b);
      case 'publish':
        return this.rtcPublish(b);
      case 'subscribe':
        return this.rtcSubscribe(b);
      case 'unsubscribe':
        return this.rtcUnsubscribe(b);
      case 'renegotiate':
        return this.rtcRenegotiate(b);
      case 'unpublish':
        return this.rtcUnpublish(b);
      case 'close':
        return this.rtcClose(b);
      default:
        return new Response('unknown op', { status: 404 });
    }
  }

  private rtcAllowed(userId: string): boolean {
    const now = this.nowMs();
    const cur = this.rtcRate.get(userId);
    if (!cur || now - cur.windowStart >= 1000) {
      this.rtcRate.set(userId, { count: 1, windowStart: now });
      return true;
    }
    cur.count += 1;
    return cur.count <= 10; // 11th call in the window → false → 429
  }

  private authorizedVoice(userId: string, channelId: string): boolean {
    const r = [
      ...this.sql.exec<{ state: string; channel_id: string | null }>(
        'SELECT state, channel_id FROM presence WHERE user_id = ?',
        userId,
      ),
    ][0];
    return !!r && r.state === 'voice' && r.channel_id === channelId;
  }

  // Server-side SFU call. The bearer secret is set here and never leaves the DO.
  private sfu(path: string, method: string, body?: unknown): Promise<Response> {
    return fetch(`https://rtc.live.cloudflare.com/v1/apps/${this.env.CF_APP_ID}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.env.CF_APP_SECRET}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async rtcSession(b: any): Promise<Response> {
    if (!this.authorizedVoice(b.userId, b.channelId)) return Response.json({ code: 'not_in_voice' }, { status: 403 });
    const res = await this.sfu('/sessions/new', 'POST');
    const sfu = await res.json<any>();
    if (res.ok && sfu?.sessionId) await this.ctx.storage.put(`sess:${b.userId}`, sfu.sessionId);
    return Response.json({ sfu }, { status: res.status });
  }

  private async rtcPublish(b: any): Promise<Response> {
    if (!this.authorizedVoice(b.userId, b.channelId)) return Response.json({ code: 'not_in_voice' }, { status: 403 });
    if (b.kind === 'screen' && (await this.countScreens(b.channelId)) >= 3) {
      return Response.json({ code: 'share_limit' }, { status: 409 });
    }
    const sessionId = await this.ctx.storage.get<string>(`sess:${b.userId}`);
    if (!sessionId) return Response.json({ code: 'no_session' }, { status: 400 });

    const res = await this.sfu(`/sessions/${sessionId}/tracks/new`, 'POST', b.sfu);
    const sfu = await res.json<any>();
    if (res.ok) {
      // The SFU closes tracks by transceiver mid (CloseTracksRequest); remember the
      // publisher's mid (from its request) for rtcUnpublish. Kept out of the track
      // registry record so `tracks` broadcasts stay exactly TrackInfo-shaped.
      const mid = b.sfu?.tracks?.[0]?.mid;
      if (mid) await this.ctx.storage.put(`pubmid:${b.userId}:${b.trackName}`, mid);
      await this.ctx.storage.put(`track:${b.userId}:${b.trackName}`, {
        ownerId: b.userId,
        trackName: b.trackName,
        kind: b.kind,
        simulcast: !!b.simulcast,
        width: b.width ?? 0,
        height: b.height ?? 0,
        fps: b.fps ?? 0,
        channelId: b.channelId,
      });
      await this.broadcastTracks(b.userId);
    }
    return Response.json({ sfu }, { status: res.status });
  }

  private async rtcSubscribe(b: any): Promise<Response> {
    if (!this.authorizedVoice(b.userId, b.channelId)) return Response.json({ code: 'not_in_voice' }, { status: 403 });
    const ownerSessionId = await this.ctx.storage.get<string>(`sess:${b.ownerId}`);
    const track = await this.ctx.storage.get<any>(`track:${b.ownerId}:${b.trackName}`);
    if (!ownerSessionId || !track) return Response.json({ code: 'no_track' }, { status: 404 });

    const isVideo = track.kind === 'screen' || track.kind === 'webcam';
    if (isVideo && (await this.budgetLevel()) === 'hard') {
      return Response.json({ code: 'budget_exceeded' }, { status: 403 });
    }
    const subSessionId = await this.ctx.storage.get<string>(`sess:${b.userId}`);
    if (!subSessionId) return Response.json({ code: 'no_session' }, { status: 400 });

    const layer: 'l' | 'h' = b.layer === 'l' ? 'l' : 'h';
    const remote: any = { location: 'remote', sessionId: ownerSessionId, trackName: b.trackName };
    // Single-encoding tracks ignore `layer` — no rid selection field sent.
    if (track.simulcast) {
      remote.simulcast = { preferredRid: layer, priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' };
    }
    const sfuReq: any = { tracks: [remote] };
    if (b.sfu?.sessionDescription) sfuReq.sessionDescription = b.sfu.sessionDescription;

    const res = await this.sfu(`/sessions/${subSessionId}/tracks/new`, 'POST', sfuReq);
    const sfu = await res.json<any>();
    if (res.ok) {
      const mid = sfu?.tracks?.[0]?.mid;
      if (mid) await this.ctx.storage.put(`pullmid:${b.userId}:${b.ownerId}:${b.trackName}`, mid);
      const bitrateKbps = pulledBitrateKbps(track as TrackShape, layer);
      await this.ctx.storage.put(`acc:${b.userId}:${b.ownerId}:${b.trackName}`, {
        bitrateKbps,
        sinceMs: this.nowMs(),
      });
    }
    return Response.json({ sfu }, { status: res.status });
  }

  private async rtcUnsubscribe(b: any): Promise<Response> {
    await this.finalizeAccrual(`acc:${b.userId}:${b.ownerId}:${b.trackName}`);
    const sessionId = await this.ctx.storage.get<string>(`sess:${b.userId}`);
    // CloseTracksRequest closes by mid; force=true stops the data flow without a
    // renegotiation round-trip (the client tears down its own side independently).
    const midKey = `pullmid:${b.userId}:${b.ownerId}:${b.trackName}`;
    const mid = await this.ctx.storage.get<string>(midKey);
    await this.ctx.storage.delete(midKey);
    const res =
      sessionId && mid
        ? await this.sfu(`/sessions/${sessionId}/tracks/close`, 'PUT', { tracks: [{ mid }], force: true })
        : null;
    return Response.json({ sfu: res ? await res.json<any>() : null }, { status: res?.status ?? 200 });
  }

  private async rtcRenegotiate(b: any): Promise<Response> {
    if (!this.authorizedVoice(b.userId, b.channelId)) return Response.json({ code: 'not_in_voice' }, { status: 403 });
    const sessionId = await this.ctx.storage.get<string>(`sess:${b.userId}`);
    if (!sessionId) return Response.json({ code: 'no_session' }, { status: 400 });
    const res = await this.sfu(`/sessions/${sessionId}/renegotiate`, 'PUT', b.sfu);
    return Response.json({ sfu: await res.json<any>() }, { status: res.status });
  }

  private async rtcUnpublish(b: any): Promise<Response> {
    const sessionId = await this.ctx.storage.get<string>(`sess:${b.userId}`);
    const midKey = `pubmid:${b.userId}:${b.trackName}`;
    const mid = await this.ctx.storage.get<string>(midKey);
    await this.ctx.storage.delete(midKey);
    const res =
      sessionId && mid
        ? await this.sfu(`/sessions/${sessionId}/tracks/close`, 'PUT', { tracks: [{ mid }], force: true })
        : null;
    await this.ctx.storage.delete(`track:${b.userId}:${b.trackName}`);
    await this.broadcastTracks(b.userId);
    return Response.json({ sfu: res ? await res.json<any>() : null }, { status: res?.status ?? 200 });
  }

  private async rtcClose(b: any): Promise<Response> {
    // The SFU has no session-close endpoint (OpenAPI 2024-05-21): sessions end when the
    // client's PeerConnection goes away. Settle accruals + clear the registry here.
    await this.clearUserMedia(b.userId);
    return Response.json({ sfu: null }, { status: 200 });
  }

  // ---- track registry + accrual --------------------------------------------

  private async countScreens(channelId: string): Promise<number> {
    const all = await this.ctx.storage.list<any>({ prefix: 'track:' });
    let n = 0;
    for (const [, t] of all) if (t.channelId === channelId && t.kind === 'screen') n += 1;
    return n;
  }

  private async tracksOf(ownerId: string): Promise<TrackInfo[]> {
    const all = await this.ctx.storage.list<any>({ prefix: `track:${ownerId}:` });
    return [...all.values()].map((t) => ({
      ownerId: t.ownerId,
      trackName: t.trackName,
      kind: t.kind,
      simulcast: t.simulcast,
      width: t.width,
      height: t.height,
      fps: t.fps,
    }));
  }

  private async broadcastTracks(ownerId: string): Promise<void> {
    this.broadcast({ t: 'tracks', ownerId, tracks: await this.tracksOf(ownerId) });
  }

  private async allTracks(): Promise<TrackInfo[]> {
    const all = await this.ctx.storage.list<any>({ prefix: 'track:' });
    return [...all.values()].map((t) => ({
      ownerId: t.ownerId,
      trackName: t.trackName,
      kind: t.kind,
      simulcast: t.simulcast,
      width: t.width,
      height: t.height,
      fps: t.fps,
    }));
  }

  private async budgetLevel(): Promise<string> {
    return (await this.ctx.storage.get<string>('budgetLevel')) ?? 'ok';
  }

  // Settle an accrual entry up to now, add to pendingGb, and remove it (§1:
  // finalize on unsubscribe / close / webSocketClose / stale-sweep).
  private async finalizeAccrual(key: string): Promise<void> {
    const e = await this.ctx.storage.get<{ bitrateKbps: number; sinceMs: number }>(key);
    if (!e) return;
    const gb = (e.bitrateKbps * (this.nowMs() - e.sinceMs)) / 8e9;
    const pending = (await this.ctx.storage.get<number>('pendingGb')) ?? 0;
    await this.ctx.storage.put('pendingGb', pending + gb);
    await this.ctx.storage.delete(key);
  }

  private async finalizeSubscriber(userId: string): Promise<void> {
    const entries = await this.ctx.storage.list({ prefix: `acc:${userId}:` });
    for (const key of entries.keys()) await this.finalizeAccrual(key);
  }

  private async clearUserMedia(userId: string): Promise<void> {
    await this.finalizeSubscriber(userId);
    for (const prefix of [`track:${userId}:`, `pubmid:${userId}:`, `pullmid:${userId}:`]) {
      const keys = await this.ctx.storage.list({ prefix });
      for (const key of keys.keys()) await this.ctx.storage.delete(key);
    }
    await this.ctx.storage.delete(`sess:${userId}`);
    this.broadcast({ t: 'tracks', ownerId: userId, tracks: [] });
  }

  // Flush accrual → D1 (§1 60 s alarm job 2). Settles active entries, upserts
  // this server's budget_usage row, re-evaluates the account-wide level, and
  // broadcasts `budget` on change.
  private async flushBudget(): Promise<void> {
    const now = this.nowMs();
    let gb = (await this.ctx.storage.get<number>('pendingGb')) ?? 0;
    let activeKbps = 0;
    const active = await this.ctx.storage.list<{ bitrateKbps: number; sinceMs: number }>({ prefix: 'acc:' });
    for (const [key, e] of active) {
      gb += (e.bitrateKbps * (now - e.sinceMs)) / 8e9;
      activeKbps += e.bitrateKbps;
      await this.ctx.storage.put(key, { ...e, sinceMs: now });
    }
    await this.ctx.storage.put('pendingGb', 0);

    const month = new Date(now).toISOString().slice(0, 7);
    if (this.serverId && gb > 0) {
      await this.env.DB.prepare(
        `INSERT INTO budget_usage (month, server_id, est_gb) VALUES (?, ?, ?)
         ON CONFLICT(month, server_id) DO UPDATE SET est_gb = est_gb + excluded.est_gb`,
      )
        .bind(month, this.serverId, gb)
        .run();
    }
    const row = await this.env.DB.prepare(
      'SELECT COALESCE(SUM(est_gb), 0) AS total FROM budget_usage WHERE month = ?',
    )
      .bind(month)
      .first<{ total: number }>();
    const total = row?.total ?? 0;
    const level = total >= this.env.BUDGET_HARD_GB ? 'hard' : total >= this.env.BUDGET_SOFT_GB ? 'soft' : 'ok';
    const prev = await this.ctx.storage.get<string>('budgetLevel');
    await this.ctx.storage.put('budgetLevel', level);
    if (level !== prev) {
      this.broadcast({ t: 'budget', level, estMbps: (activeKbps * 1000) / 1e6, monthGb: total });
    }
  }

  // Fixed-window unlock counter (§1). 6th attempt within the window → not allowed.
  private async consumeUnlockAttempt(userId: string, channelId: string): Promise<boolean> {
    const key = `unlock:${userId}:${channelId}`;
    const now = this.nowMs();
    const cur = await this.ctx.storage.get<{ count: number; windowStart: number }>(key);
    if (!cur || now - cur.windowStart >= UNLOCK_WINDOW_MS) {
      await this.ctx.storage.put(key, { count: 1, windowStart: now });
      return true;
    }
    const next = { count: cur.count + 1, windowStart: cur.windowStart };
    await this.ctx.storage.put(key, next);
    return next.count <= UNLOCK_MAX_ATTEMPTS;
  }
}
