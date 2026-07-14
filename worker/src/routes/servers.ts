import { Hono } from "hono";
import { z } from "zod";
import {
  ActivityPage,
  CreateServerRequest,
  JoinServerRequest,
  LIMITS,
  PatchServerRequest,
  PointConfig,
  PollPage,
  StatsResponse,
  TavernHomeResponse,
} from "@tavern/shared";
import type { ErrorCode, MemberInit, ServerSummary, UserProfile } from "@tavern/shared";
import { requireAdmin, requireAuth, requireMember, zodJson } from "../middleware";
import type { MemberVars } from "../middleware";
import { hashServerPassword, verifyServerPassword } from "../lib/passwords";
import { voiceAvatarFromStorage } from "../lib/voiceAvatar";

// Non-null narrow without `!` (§9.1): mirrors the helper in routes/me.ts.
function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// The stored server row (password_hash is the secret and NEVER leaves the server — ServerSummary
// exposes only the boolean `hasPassword`).
type ServerRow = {
  id: string;
  nickname: string;
  password_hash: string | null;
  admin_user_id: string;
  created_at: number;
};

// The joined member's user columns (same projection as routes/me.ts readProfile — email is never
// selected, §5.1). avatar_key stays NULL for a member with no avatar.
type MemberRow = {
  id: string;
  username: string;
  display_name: string;
  color: string;
  avatar_key: string | null;
  voice_avatar: string | null;
};

// Builds the wire ServerSummary from a stored row + the caller's membership timestamp. hasPassword
// is derived from the hash's presence; the hash itself is dropped here.
function toSummary(row: ServerRow, joinedAt: number): ServerSummary {
  return {
    id: row.id,
    nickname: row.nickname,
    adminUserId: row.admin_user_id,
    hasPassword: row.password_hash !== null,
    createdAt: row.created_at,
    joinedAt,
  };
}

// UserProfile from a member row (avatarKey omitted when NULL to satisfy exactOptionalPropertyTypes).
function toProfile(row: MemberRow): UserProfile {
  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    color: row.color,
    ...(row.avatar_key !== null ? { avatarKey: row.avatar_key } : {}),
    ...(row.voice_avatar !== null ? { voiceAvatar: voiceAvatarFromStorage(row.voice_avatar) } : {}),
  };
}

// Count of servers the user belongs to (the per-user cap is on membership count, §App-B).
async function membershipCount(env: Env, userId: string): Promise<number> {
  const row = invariant(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>(),
    "COUNT(*) returns a row",
  );
  return row.n;
}

// The DO member-profile cache seed (S3.1 /internal/member-join). id/nickname/adminUserId are the
// `serverMeta` the DO serves in `hello.ok`; the DO overwrites `meta` on every join (idempotent).
type RoomMeta = { id: string; nickname: string; adminUserId: string };

// Reads the caller's profile columns from the auth `user` row (no email selected) and packs a
// MemberInit for the DO cache. avatarKey omitted when NULL (exactOptionalPropertyTypes).
async function readMemberInit(
  env: Env,
  userId: string,
  isAdmin: boolean,
  joinedAt: number,
): Promise<MemberInit> {
  const row = invariant(
    await env.DB.prepare(
      "SELECT id, username, display_name, color, avatar_key, voice_avatar FROM user WHERE id = ?",
    )
      .bind(userId)
      .first<MemberRow>(),
    "member user row missing",
  );
  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    color: row.color,
    ...(row.avatar_key !== null ? { avatarKey: row.avatar_key } : {}),
    ...(row.voice_avatar !== null ? { voiceAvatar: voiceAvatarFromStorage(row.voice_avatar) } : {}),
    isAdmin,
    joinedAt,
  };
}

// Seeds the server's ServerRoom DO member-profile cache + serverMeta and broadcasts `member.joined`
// (S3.1 /internal/member-join). Awaited so the cache is warm before the caller returns; a DO failure
// is logged, never fatal — D1 is the source of truth and the cache rebuilds on the next join/hello
// (§9.5 — surfaced to Workers telemetry, never swallowed silently).
async function notifyMemberJoin(
  env: Env,
  serverId: string,
  member: MemberInit,
  serverMeta: RoomMeta,
): Promise<void> {
  try {
    const stub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
    await stub.fetch("https://do.internal/internal/member-join", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
      body: JSON.stringify({ member, serverMeta }),
    });
  } catch (err: unknown) {
    console.error("member-join DO notify failed", err);
  }
}

// Tells the server's DO the nickname changed (FR-12): it updates its cached `serverMeta.nickname` and
// broadcasts `server.updated` to every live socket. Awaited; a DO failure is logged, never fatal — D1
// is the source of truth and the cache re-syncs on the next member-join/hello (§9.5).
async function notifyServerUpdated(env: Env, serverId: string, nickname: string): Promise<void> {
  try {
    const stub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
    await stub.fetch("https://do.internal/internal/server-updated", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
      body: JSON.stringify({ nickname }),
    });
  } catch (err: unknown) {
    console.error("server-updated DO notify failed", err);
  }
}

// Tells the server's DO to evict a kicked member (FR-11): it closes the user's live sockets with a
// `kicked` frame + close 4001, drops the member cache, and appends the `member.kick` activity (meta
// carries the acting admin `by`). Called AFTER the D1 membership row is deleted (pinned order — a
// racing rejoin then re-checks the password). Awaited; a DO failure is logged, never fatal (§9.5).
async function notifyKick(env: Env, serverId: string, userId: string, by: string): Promise<void> {
  try {
    const stub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
    await stub.fetch("https://do.internal/internal/kick", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
      body: JSON.stringify({ userId, by }),
    });
  } catch (err: unknown) {
    console.error("kick DO notify failed", err);
  }
}

export const serversRoute = new Hono<{ Bindings: Env; Variables: MemberVars }>();

// POST /api/servers (FR-08): create a server, creator becomes admin + first member, 2 default
// channels seeded (FR-13). zodJson already rejected a bad nickname/password/code with 400
// bad_request. Creation is gated by a one-time operator-seeded code (migration 0003): the code is
// claimed with a conditional UPDATE (used_at IS NULL) so two racing creates can never both spend
// it, and the claim records who used it, when, and which server it created.
serversRoute.post("/", requireAuth, zodJson(CreateServerRequest), async (c) => {
  const userId = invariant(c.var.userId, "requireAuth guarantees userId");
  const body = CreateServerRequest.parse(await c.req.json());

  // Case-insensitive uniqueness (the column is COLLATE NOCASE, so `=` compares NOCASE).
  const clash = await c.env.DB.prepare("SELECT id FROM servers WHERE nickname = ?")
    .bind(body.nickname)
    .first();
  if (clash !== null) {
    return c.json({ error: "nickname_taken" satisfies ErrorCode }, 409);
  }

  if ((await membershipCount(c.env, userId)) >= LIMITS.maxServersPerUser) {
    return c.json({ error: "server_cap" satisfies ErrorCode }, 403);
  }

  const now = Date.now();
  const serverId = crypto.randomUUID();
  const passwordHash = await hashServerPassword(body.password);

  // Claim the one-time code AFTER the cheap validations (so a nickname clash never burns a code)
  // and BEFORE the inserts. `changes === 0` covers both an unknown and an already-used code —
  // deliberately the same `invalid_code` answer, so the response doesn't reveal which codes exist.
  const claim = await c.env.DB.prepare(
    `UPDATE server_creation_codes
     SET used_by_user_id = ?, used_at = ?, created_server_id = ?
     WHERE code = ? AND used_at IS NULL`,
  )
    .bind(userId, now, serverId, body.code)
    .run();
  if (claim.meta.changes !== 1) {
    return c.json({ error: "invalid_code" satisfies ErrorCode }, 403);
  }

  // One atomic batch: server + the 2 fixed channels (voice "Voice", text "General", FR-13) +
  // the creator's membership row. If the batch loses a nickname race (UNIQUE) the claimed code is
  // released — the guard on created_server_id ensures only OUR claim is ever rolled back.
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO servers (id, nickname, password_hash, admin_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(serverId, body.nickname, passwordHash, userId, now),
      c.env.DB.prepare(
        "INSERT INTO channels (id, server_id, kind, name, created_at) VALUES (?, ?, 'voice', 'Voice', ?)",
      ).bind(crypto.randomUUID(), serverId, now),
      c.env.DB.prepare(
        "INSERT INTO channels (id, server_id, kind, name, created_at) VALUES (?, ?, 'text', 'General', ?)",
      ).bind(crypto.randomUUID(), serverId, now),
      c.env.DB.prepare(
        "INSERT INTO memberships (user_id, server_id, joined_at) VALUES (?, ?, ?)",
      ).bind(userId, serverId, now),
    ]);
  } catch (err: unknown) {
    await c.env.DB.prepare(
      `UPDATE server_creation_codes
       SET used_by_user_id = NULL, used_at = NULL, created_server_id = NULL
       WHERE code = ? AND created_server_id = ?`,
    )
      .bind(body.code, serverId)
      .run();
    throw err;
  }

  // Seed the DO cache: the creator is the admin + first member (FR-08). serverMeta carries the full
  // {id, nickname, adminUserId} the DO serves in hello.ok.
  const member = await readMemberInit(c.env, userId, true, now);
  await notifyMemberJoin(c.env, serverId, member, {
    id: serverId,
    nickname: body.nickname,
    adminUserId: userId,
  });

  const summary = toSummary(
    {
      id: serverId,
      nickname: body.nickname,
      password_hash: passwordHash,
      admin_user_id: userId,
      created_at: now,
    },
    now,
  );
  return c.json(summary, 201);
});

// POST /api/servers/join (FR-09): join by nickname (+ optional password). Idempotent — a re-join
// returns the existing summary and is checked BEFORE the fullness guard so a member is never locked
// out of their own server.
serversRoute.post("/join", requireAuth, zodJson(JoinServerRequest), async (c) => {
  const userId = invariant(c.var.userId, "requireAuth guarantees userId");
  const body = JoinServerRequest.parse(await c.req.json());

  const server = await c.env.DB.prepare(
    "SELECT id, nickname, password_hash, admin_user_id, created_at FROM servers WHERE nickname = ?",
  )
    .bind(body.nickname)
    .first<ServerRow>();
  if (server === null) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }

  if (server.password_hash !== null) {
    const ok =
      body.password !== undefined &&
      (await verifyServerPassword(body.password, server.password_hash));
    if (!ok) {
      return c.json({ error: "wrong_password" satisfies ErrorCode }, 403);
    }
  }

  // Already a member → return the existing summary (before any cap/fullness check).
  const existing = await c.env.DB.prepare(
    "SELECT joined_at FROM memberships WHERE user_id = ? AND server_id = ?",
  )
    .bind(userId, server.id)
    .first<{ joined_at: number }>();
  if (existing !== null) {
    return c.json(toSummary(server, existing.joined_at));
  }

  if ((await membershipCount(c.env, userId)) >= LIMITS.maxServersPerUser) {
    return c.json({ error: "server_cap" satisfies ErrorCode }, 403);
  }

  // FR-09 max-members cap: count ≥ cap → server_full.
  const memberCount = invariant(
    await c.env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE server_id = ?")
      .bind(server.id)
      .first<{ n: number }>(),
    "COUNT(*) returns a row",
  ).n;
  if (memberCount >= LIMITS.maxMembersPerServer) {
    return c.json({ error: "server_full" satisfies ErrorCode }, 403);
  }

  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO memberships (user_id, server_id, joined_at) VALUES (?, ?, ?)")
    .bind(userId, server.id, now)
    .run();

  // Seed the DO cache for the new member (FR-09). isAdmin only if the joiner IS the server admin.
  const member = await readMemberInit(c.env, userId, userId === server.admin_user_id, now);
  await notifyMemberJoin(c.env, server.id, member, {
    id: server.id,
    nickname: server.nickname,
    adminUserId: server.admin_user_id,
  });

  return c.json(toSummary(server, now));
});

// GET /api/servers/:id/members: member profiles (presence is pushed over WS by the DO, not here).
serversRoute.get("/:id/members", requireMember, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.color, u.avatar_key, u.voice_avatar
     FROM memberships m JOIN user u ON u.id = m.user_id
     WHERE m.server_id = ?
     ORDER BY m.joined_at ASC`,
  )
    .bind(c.var.serverId)
    .all<MemberRow>();
  const members: UserProfile[] = rows.results.map(toProfile);
  return c.json({ members });
});

// PATCH /api/servers/:id (FR-10 password, FR-12 rename): admin-only. `requireMember` runs first (a
// non-member gets `not_member`), then `requireAdmin` (a non-admin member gets `not_admin`). zodJson
// rejected an empty body / bad nickname / too-short password with 400 bad_request. The `id` never
// changes (FR-12). Returns the updated `ServerSummary`.
serversRoute.patch("/:id", requireMember, requireAdmin, zodJson(PatchServerRequest), async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const body = PatchServerRequest.parse(await c.req.json());

  const server = invariant(
    await c.env.DB.prepare(
      "SELECT id, nickname, password_hash, admin_user_id, created_at FROM servers WHERE id = ?",
    )
      .bind(serverId)
      .first<ServerRow>(),
    "requireAdmin guarantees the server exists",
  );

  // FR-12 rename: NOCASE uniqueness EXCLUDING self (the column is COLLATE NOCASE, so `=` compares
  // NOCASE). On success update D1 and tell the DO to broadcast `server.updated`.
  if (body.nickname !== undefined) {
    const clash = await c.env.DB.prepare("SELECT id FROM servers WHERE nickname = ? AND id <> ?")
      .bind(body.nickname, serverId)
      .first();
    if (clash !== null) {
      return c.json({ error: "nickname_taken" satisfies ErrorCode }, 409);
    }
    await c.env.DB.prepare("UPDATE servers SET nickname = ? WHERE id = ?")
      .bind(body.nickname, serverId)
      .run();
    server.nickname = body.nickname;
    await notifyServerUpdated(c.env, serverId, body.nickname);
  }

  // FR-10 password: replaces the stored hash (clearing is not possible — a server password is
  // always set). Existing members are untouched — this only affects the NEXT join attempt.
  if (body.password !== undefined) {
    const passwordHash = await hashServerPassword(body.password);
    await c.env.DB.prepare("UPDATE servers SET password_hash = ? WHERE id = ?")
      .bind(passwordHash, serverId)
      .run();
    server.password_hash = passwordHash;
  }

  // The summary's joinedAt is the admin's own membership timestamp (they are a member of the server).
  const membership = invariant(
    await c.env.DB.prepare("SELECT joined_at FROM memberships WHERE user_id = ? AND server_id = ?")
      .bind(userId, serverId)
      .first<{ joined_at: number }>(),
    "the admin is a member of their own server",
  );
  return c.json(toSummary(server, membership.joined_at));
});

// DELETE /api/servers/:id/members/:userId (FR-11 kick): admin-only. Pinned order — (1) delete the D1
// membership row, (2) POST /internal/kick to the DO — so a racing rejoin re-checks the password. The
// admin cannot kick themselves (400; ownership transfer is a non-goal); an unknown target → 404.
serversRoute.delete("/:id/members/:userId", requireMember, requireAdmin, async (c) => {
  const adminId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const targetId = invariant(c.req.param("userId"), "route guarantees :userId");

  if (targetId === adminId) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }

  const membership = await c.env.DB.prepare(
    "SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?",
  )
    .bind(targetId, serverId)
    .first();
  if (membership === null) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }

  // (1) D1 membership removed first (source of truth); (2) DO eviction second.
  await c.env.DB.prepare("DELETE FROM memberships WHERE user_id = ? AND server_id = ?")
    .bind(targetId, serverId)
    .run();
  await notifyKick(c.env, serverId, targetId, adminId);

  return c.body(null, 204);
});

// Pagination query for the activity read (§6.1 `?before&limit`). Both optional positive ints; a
// coercion failure is a client bug → 400 bad_request. `limit` is NOT capped here — the DO's page()
// clamps it to LIMITS.historyPageSize (one clamp, two callers, mirrors chat).
const ActivityQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
const PollQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

// GET /api/servers/:id/activity?before&limit (FR-39): member-gated read proxied to the DO (reads that
// don't need a push are HTTP, §6.1). The DO owns pagination; the Worker validates the response against
// the shared `ActivityPage` schema (§9.8: parse at the receiving side of the DO→Worker boundary).
serversRoute.get("/:id/activity", requireMember, async (c) => {
  const query = ActivityQuery.safeParse({
    before: c.req.query("before"),
    limit: c.req.query("limit"),
  });
  if (!query.success) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }
  const params = new URLSearchParams();
  if (query.data.before !== undefined) params.set("before", String(query.data.before));
  if (query.data.limit !== undefined) params.set("limit", String(query.data.limit));

  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(c.var.serverId));
  const res = await stub.fetch(`https://do.internal/internal/activity?${params.toString()}`, {
    headers: { "X-Tavern-Internal": "1" },
  });
  const page: unknown = await res.json();
  return c.json(ActivityPage.parse(page));
});

serversRoute.get("/:id/polls", requireMember, async (c) => {
  const query = PollQuery.safeParse({
    before: c.req.query("before"),
    limit: c.req.query("limit"),
  });
  if (!query.success) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const params = new URLSearchParams({ userId });
  if (query.data.before !== undefined) params.set("before", String(query.data.before));
  if (query.data.limit !== undefined) params.set("limit", String(query.data.limit));
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(c.var.serverId));
  const res = await stub.fetch(`https://do.internal/internal/polls?${params.toString()}`, {
    headers: { "X-Tavern-Internal": "1" },
  });
  const page: unknown = await res.json();
  return c.json(PollPage.parse(page));
});

// GET /api/servers/:id/home: member-gated bounded recap for the idle center canvas.
serversRoute.get("/:id/home", requireMember, async (c) => {
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(c.var.serverId));
  const res = await stub.fetch("https://do.internal/internal/home", {
    headers: { "X-Tavern-Internal": "1" },
  });
  const body: unknown = await res.json();
  return c.json(TavernHomeResponse.parse(body));
});

// GET /api/servers/:id/stats (FR-40): member-gated snapshot proxied to the DO. The DO computes the
// server-authoritative stats (§6.1); the Worker validates the DO→Worker boundary against the shared
// `StatsResponse` schema (§9.8).
serversRoute.get("/:id/stats", requireMember, async (c) => {
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(c.var.serverId));
  const res = await stub.fetch("https://do.internal/internal/stats", {
    headers: { "X-Tavern-Internal": "1" },
  });
  const stats: unknown = await res.json();
  return c.json(StatsResponse.parse(stats));
});

// PUT /api/servers/:id/points/config: the server admin owns this server's economy. The Worker
// authenticates + authorizes against D1, then the room DO settles the old rates and atomically
// installs the new configuration before notifying connected members.
serversRoute.put(
  "/:id/points/config",
  requireMember,
  requireAdmin,
  zodJson(PointConfig),
  async (c) => {
    const userId = invariant(c.var.userId, "requireAdmin guarantees userId");
    const config = PointConfig.parse(await c.req.json());
    const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(c.var.serverId));
    const res = await stub.fetch("https://do.internal/internal/points/config", {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
      body: JSON.stringify({ userId, config }),
    });
    const body: unknown = await res.json();
    return c.json(PointConfig.parse(body));
  },
);
