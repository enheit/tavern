import { Hono } from "hono";
import type { ErrorCode } from "@tavern/shared";
import type { AuthVars } from "../middleware";

// PUBLIC capability route for a chat image's bytes: GET /api/chat-images/:serverId/:file. Mirrors the
// screenshot view route (routes/screenshotView.ts): the raw bytes serve WITHOUT auth so a pasted image
// opens in a plain browser tab everywhere — a web new tab AND, in Electron, the OS default browser
// (setWindowOpenHandler only hands https: URLs to an external browser, where the app session does not
// exist). Security is the unguessable path: both `serverId` and the image id are v4 UUIDs (≈256 bits),
// so the URL is a bearer capability. `withAuth` still runs upstream (it only resolves the session,
// never blocks), so an anonymous request is fine. Only the `{serverId}/chat-images/*` prefix is reachable.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/i;

export const chatImageViewRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

chatImageViewRoute.get("/:serverId/:file", async (c) => {
  const serverId = c.req.param("serverId");
  const file = c.req.param("file");
  // Reject anything that is not a chat-image key so this route can only ever read `*/chat-images/*`.
  if (!UUID_RE.test(serverId) || !FILE_RE.test(file)) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }

  const object = await c.env.MEDIA.get(`${serverId}/chat-images/${file}`);
  if (object === null) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }

  const headers = new Headers();
  headers.set("etag", object.httpEtag);
  // Content is immutable (a UUID names exactly one image) → cache hard once fetched.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("content-type", object.httpMetadata?.contentType ?? "image/webp");
  return new Response(object.body, { headers });
});
