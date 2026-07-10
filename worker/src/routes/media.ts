import { Hono } from "hono";
import type { ErrorCode } from "@tavern/shared";
import { requireAuth } from "../middleware";
import type { AuthVars } from "../middleware";

// The key is the path remainder after this prefix; c.req.path is the full original path even when the
// router is mounted, so the slice is stable (PLAN §6.1 `GET /api/media/*`).
const MEDIA_PREFIX = "/api/media/";

export const mediaRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// GET /api/media/* (PLAN §5.3, §6.1): streamed R2 read. `avatars/*` is readable by ANY authenticated
// user (avatars render across every server); every other prefix (sounds/, recordings/) needs a
// per-server membership check that S2.1 adds — pinned to 403 not_member here so the route and its
// allow-list exist exactly once.
mediaRoute.get("/*", requireAuth, async (c) => {
  const key = decodeURIComponent(c.req.path.slice(MEDIA_PREFIX.length));

  if (!key.startsWith("avatars/")) {
    return c.json({ error: "not_member" satisfies ErrorCode }, 403);
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
