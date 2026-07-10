import { Hono } from "hono";
import type { ErrorCode } from "@tavern/shared";
import { requireAuth } from "../middleware";
import type { AuthVars } from "../middleware";

// Non-null narrow without `!` (§9.1): mirrors the helper in routes/me.ts.
function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// The key is the path remainder after this prefix; c.req.path is the full original path even when the
// router is mounted, so the slice is stable (PLAN §6.1 `GET /api/media/*`).
const MEDIA_PREFIX = "/api/media/";

export const mediaRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// GET /api/media/* (PLAN §5.3, §6.1): streamed R2 read. `avatars/*` is readable by ANY authenticated
// user (avatars render across every server); `sounds/{serverId}/…` and `recordings/{serverId}/…`
// require the caller to be a member of that server (serverId = the 2nd path segment). Any other
// prefix is denied. Membership failures and unknown prefixes both return 403 not_member.
mediaRoute.get("/*", requireAuth, async (c) => {
  const key = decodeURIComponent(c.req.path.slice(MEDIA_PREFIX.length));

  if (!key.startsWith("avatars/")) {
    const segments = key.split("/");
    const scoped = segments[0] === "sounds" || segments[0] === "recordings";
    const serverId = segments[1];
    if (!scoped || serverId === undefined || serverId === "") {
      return c.json({ error: "not_member" satisfies ErrorCode }, 403);
    }
    const userId = invariant(c.var.userId, "requireAuth guarantees userId");
    const membership = await c.env.DB.prepare(
      "SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?",
    )
      .bind(userId, serverId)
      .first();
    if (membership === null) {
      return c.json({ error: "not_member" satisfies ErrorCode }, 403);
    }
  }

  const object = await c.env.MEDIA.get(key);
  if (object === null) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }

  const headers = new Headers();
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=86400");
  const contentType = object.httpMetadata?.contentType;
  if (contentType !== undefined) headers.set("content-type", contentType);
  return new Response(object.body, { headers });
});
