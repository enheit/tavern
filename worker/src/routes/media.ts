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

// Fallback content-type inferred from the key extension. Recordings finalized before we began stamping
// httpMetadata.contentType (and any object stored without a type) would otherwise be served untyped,
// which makes browsers refuse to decode the audio — so infer from the well-known suffixes we produce.
function contentTypeFromKey(key: string): string | undefined {
  if (key.endsWith(".webm")) return "audio/webm";
  if (key.endsWith(".mp3")) return "audio/mpeg";
  if (key.endsWith(".webp")) return "image/webp";
  return undefined;
}

// Parse a single-range `Range: bytes=…` header into an explicit R2Range we hand to R2 ourselves. We do
// not read back `object.range` for the response (its resolved shape is ambiguous across runtimes) — we
// know exactly what we asked for. `null` means absent/malformed/multi-range → the caller serves 200.
function parseRangeHeader(header: string | undefined): R2Range | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const startStr = match[1];
  const endStr = match[2];
  if (startStr === "" && endStr === "") return null;
  if (startStr === "") {
    const suffix = Number(endStr);
    return suffix > 0 ? { suffix } : null; // last N bytes
  }
  const offset = Number(startStr);
  if (endStr === "") return { offset }; // offset → end
  const end = Number(endStr);
  return end >= offset ? { offset, length: end - offset + 1 } : null; // inclusive offset..end
}

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

  // Serve byte ranges so a media element can seek. Recorded WebM carries no Duration in its header
  // (§7.4), so Chrome derives the clip length by ranging to the tail — without Accept-Ranges + a
  // working range read the element is stuck at 0:00 / 0:00.
  const range = parseRangeHeader(c.req.header("range"));
  const object = await c.env.MEDIA.get(key, range !== null ? { range } : undefined);
  if (object === null) {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Avatars live at a STABLE per-user URL (avatars/{userId}.webp) that is overwritten in place on
  // re-upload, so a long max-age would pin the stale image. `no-cache` forces revalidation; the etag
  // (R2 content hash) makes that a cheap 304 until the bytes actually change. Sounds/recordings are
  // immutable per key, so they keep the long cache.
  headers.set(
    "cache-control",
    key.startsWith("avatars/") ? "private, no-cache" : "private, max-age=86400",
  );
  headers.set("accept-ranges", "bytes");
  if (!headers.has("content-type")) {
    const inferred = contentTypeFromKey(key);
    if (inferred !== undefined) headers.set("content-type", inferred);
  }

  // Conditional-GET short circuit: if the caller already holds the current bytes (etag match) and
  // isn't ranging, return 304 with no body so revalidation stays cheap.
  if (range === null && c.req.header("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  // `object.size` is the FULL object size regardless of ranging; derive the served window from the
  // range we asked for and reply 206 + Content-Range. A plain read streams the whole body with an
  // up-front Content-Length so the element knows the total size.
  if (range !== null) {
    const start = "suffix" in range ? Math.max(0, object.size - range.suffix) : (range.offset ?? 0);
    const end =
      "suffix" in range
        ? object.size - 1
        : range.length !== undefined
          ? Math.min(start + range.length - 1, object.size - 1)
          : object.size - 1;
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
});
