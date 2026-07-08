import type { Env } from './index';

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

  private onVoiceLeave(att: Attachment): void {
    this.sql.exec(
      `UPDATE presence SET state = 'online', channel_id = NULL, last_seen = ? WHERE user_id = ?`,
      this.nowMs(),
      att.userId,
    );
    this.broadcast({ t: 'presence', userId: att.userId, state: 'online', channelId: null });
    // Track registry / accrual teardown lands in S2.6.
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
      this.broadcast({ t: 'presence', userId: user_id, state: 'offline', channelId: null });
    }
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
      roster: roster.results.map((u) => ({
        userId: u.id,
        nickname: u.nickname,
        color: u.nickname_color,
        avatarKey: u.avatar_key,
      })),
      presence,
      tracks: [], // registry populated in S2.6
      budget: { level: 'ok', estMbps: 0, monthGb: 0 }, // budget in S2.6
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
