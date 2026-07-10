import { Hono } from "hono";
import { z } from "zod";
import {
  ActivityPage,
  CreateServerRequest,
  JoinServerRequest,
  LIMITS,
  StatsResponse,
} from "@tavern/shared";
import type { ErrorCode, MemberInit, ServerSummary, UserProfile } from "@tavern/shared";
import { requireAuth, requireMember, zodJson } from "../middleware";
import type { MemberVars } from "../middleware";
import { hashServerPassword, verifyServerPassword } from "../lib/passwords";

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
      "SELECT id, username, display_name, color, avatar_key FROM user WHERE id = ?",
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

export const serversRoute = new Hono<{ Bindings: Env; Variables: MemberVars }>();

// POST /api/servers (FR-08): create a server, creator becomes admin + first member, 2 default
// channels seeded (FR-13). zodJson already rejected a bad nickname/password with 400 bad_request.
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
  const passwordHash = body.password !== undefined ? await hashServerPassword(body.password) : null;

  // One atomic batch: server + the 2 fixed channels (voice "Voice", text "General", FR-13) +
  // the creator's membership row.
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
    `SELECT u.id, u.username, u.display_name, u.color, u.avatar_key
     FROM memberships m JOIN user u ON u.id = m.user_id
     WHERE m.server_id = ?
     ORDER BY m.joined_at ASC`,
  )
    .bind(c.var.serverId)
    .all<MemberRow>();
  const members: UserProfile[] = rows.results.map(toProfile);
  return c.json({ members });
});

// Pagination query for the activity read (§6.1 `?before&limit`). Both optional positive ints; a
// coercion failure is a client bug → 400 bad_request. `limit` is NOT capped here — the DO's page()
// clamps it to LIMITS.historyPageSize (one clamp, two callers, mirrors chat).
const ActivityQuery = z.object({
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
