import { LIMITS, serverMessageSchema } from "@tavern/shared";
import type { Member, MemberInit, Presence, ServerMessage, UserProfile } from "@tavern/shared";
import { rowToMember } from "./sql";

// The per-connection identity stashed on the hibernatable WebSocket (ids only, 16 KB cap — §A2/§6.2).
export type ConnAttachment = { userId: string; connId: string; hello: boolean };

// The server metadata snapshot the DO serves in `hello.ok` — written in full by /internal/member-join,
// `nickname` patched by /internal/server-updated. Persisted in ctx.storage KV under `meta`.
export type RoomMeta = { id: string; nickname: string; adminUserId: string };

// A single-use WS auth ticket record (A4). Stored in ctx.storage KV under `ticket:{uuid}`.
type TicketRecord = { userId: string; expiresAt: number };

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

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  // Loads the persisted room meta into memory (call once from the DO constructor's blockConcurrencyWhile).
  async load(): Promise<void> {
    this.meta = (await this.ctx.storage.get<RoomMeta>("meta")) ?? null;
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

  async patchNickname(nickname: string): Promise<void> {
    const current = this.meta;
    if (current === null) return;
    const next: RoomMeta = { ...current, nickname };
    await this.ctx.storage.put("meta", next);
    this.meta = next;
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

  helloSnapshot(userId: string): HelloOk {
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
      // Pinned stubs filled by later steps: voice (S3.4), streams (S8), recording (S9.3),
      // lastMessageId (S3.2), costStatus (S7.1).
      voice: { members: [], sessionStartedAt: null },
      streams: [],
      recording: { active: false },
      lastMessageId: 0,
      costStatus: { usedGB: 0, capGB: LIMITS.egressKillGB, blocked: false },
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
