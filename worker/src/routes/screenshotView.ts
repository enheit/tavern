import { Hono } from "hono";
import type { ErrorCode } from "@tavern/shared";
import type { AuthVars } from "../middleware";

// PUBLIC capability route for viewing a screenshot's image bytes: GET /api/screenshots/:serverId/:file.
// Unlike the member-gated LIST/DELETE (routes/screenshots.ts), the raw bytes are served WITHOUT auth so
// the still opens in a plain browser tab everywhere — a web new tab AND, in Electron, the OS default
// browser (setWindowOpenHandler only opens https: externally, where the app session does not exist).
// Security is the unguessable path: both `serverId` and the screenshot id are v4 UUIDs (≈256 bits),
// so the URL is a bearer capability. `withAuth` still runs (it only resolves the session, never blocks),
// so an anonymous request is fine here. Only the `{serverId}/screenshots/*` prefix is reachable.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/i;

export const screenshotViewRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

screenshotViewRoute.get("/:serverId/:file", async (c) => {
  const serverId = c.req.param("serverId");
  const file = c.req.param("file");
  // Reject anything that is not a screenshot key so this route can only ever read `*/screenshots/*`.
  if (!UUID_RE.test(serverId) || !FILE_RE.test(file)) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }

  const object = await c.env.MEDIA.get(`${serverId}/screenshots/${file}`);
  if (object === null) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }

  const headers = new Headers();
  headers.set("etag", object.httpEtag);
  // Content is immutable (a UUID names exactly one still) → cache hard once fetched.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("content-type", object.httpMetadata?.contentType ?? "image/webp");
  return new Response(object.body, { headers });
});
