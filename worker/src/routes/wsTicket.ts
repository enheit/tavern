import { Hono } from "hono";
import { z } from "zod";
import type { ErrorCode, MemberInit } from "@tavern/shared";
import { requireAuth, zodJson } from "../middleware";
import type { AuthVars } from "../middleware";

// Non-null narrow without `!` (§9.1).
function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// A4: the one-time WS ticket is issued after the Worker verifies session + membership. The serverId
// rides in the body (§6.1), so membership is checked inline here rather than via `requireMember`
// (which keys off the `:id` path param — a shape this endpoint does not carry).
const WsTicketRequest = z.object({ serverId: z.uuid() });

export const wsTicketRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// POST /api/ws-ticket (A4): session-gated + membership-checked → DO mints a userId-bound ticket.
wsTicketRoute.post("/ws-ticket", requireAuth, zodJson(WsTicketRequest), async (c) => {
  const userId = invariant(c.var.userId, "requireAuth guarantees userId");
  const { serverId } = WsTicketRequest.parse(await c.req.json());

  const membership = await c.env.DB.prepare(
    "SELECT joined_at FROM memberships WHERE user_id = ? AND server_id = ?",
  )
    .bind(userId, serverId)
    .first<{ joined_at: number }>();
  if (membership === null) {
    return c.json({ error: "not_member" satisfies ErrorCode }, 403);
  }

  // §9.5 cache rebuild: the DO's meta/member cache can be empty even though D1 (the source of truth)
  // has the membership — a create/join-time /internal/member-join seed is non-fatal on failure, and
  // local-dev DO state can be wiped independently of D1. Ship the D1 truth with every ticket so the
  // DO can fill missing cache pieces BEFORE the hello — without meta the DO cannot build hello.ok.
  const server = invariant(
    await c.env.DB.prepare("SELECT nickname, admin_user_id FROM servers WHERE id = ?")
      .bind(serverId)
      .first<{ nickname: string; admin_user_id: string }>(),
    "membership row implies server row",
  );
  const profile = invariant(
    await c.env.DB.prepare(
      "SELECT username, display_name, color, avatar_key FROM user WHERE id = ?",
    )
      .bind(userId)
      .first<{
        username: string;
        display_name: string;
        color: string;
        avatar_key: string | null;
      }>(),
    "session implies user row",
  );
  const member: MemberInit = {
    userId,
    username: profile.username,
    displayName: profile.display_name,
    color: profile.color,
    ...(profile.avatar_key !== null ? { avatarKey: profile.avatar_key } : {}),
    isAdmin: server.admin_user_id === userId,
    joinedAt: membership.joined_at,
  };

  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(serverId));
  const res = await stub.fetch("https://do.internal/internal/ticket", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
    body: JSON.stringify({
      userId,
      seed: {
        member,
        serverMeta: { id: serverId, nickname: server.nickname, adminUserId: server.admin_user_id },
      },
    }),
  });
  const body: { ticket: string } = await res.json();
  return c.json({ ticket: body.ticket });
});

// GET /api/servers/:id/ws?ticket=… (A4): forward the upgrade Request to the DO stub unchanged except
// for the internal header. The DO consumes the ticket (single-use, expiry) and resolves the userId —
// the DO never sees an auth token. No session gate here: the ticket IS the credential.
wsTicketRoute.get("/servers/:id/ws", (c) => {
  const serverId = invariant(c.req.param("id"), "route guarantees :id");
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Tavern-Internal", "1");
  const forwarded = new Request(c.req.raw, { headers });
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(serverId));
  return stub.fetch(forwarded);
});
