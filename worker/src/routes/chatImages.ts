import { Hono } from "hono";
import { ChatImageFromUrlRequest, CreateChatImageResponse, LIMITS } from "@tavern/shared";
import type { ErrorCode } from "@tavern/shared";
import { requireMember } from "../middleware";
import type { MemberVars } from "../middleware";

// § chat image paste routes. A member pastes an image into the composer; the client re-encodes it to a
// bounded webp and PUTs the bytes here. Unlike screenshots (which need a DO registry row + rate limit +
// broadcast for the Screenshots tab), a chat image is delivered entirely by the chat message that
// references it — so this route is a pure R2 PUT that mints + returns an id. The client then sends
// `chat.send` with an `ImageAttachment { id }`; that send is the token-bucketed, persisted step.
//
// The deterministic R2 key is server-first `{serverId}/chat-images/{id}.webp` — the same shape the
// PUBLIC view route (routes/chatImageView.ts) serves as a capability URL. The id never leaves this
// prefix, so it is only ever reachable under the server it was uploaded to (no cross-server read).

function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// The deterministic R2 key (server-first layout). The client never learns it; the Worker builds it. The
// `.webp` suffix is the capability-token shape the view route's regex accepts — the stored bytes carry
// their real content-type in R2 metadata (webp for the paste path; the source type for the from-url
// path), which the view route echoes, so the extension is opaque, not a format guarantee.
function r2Key(serverId: string, imageId: string): string {
  return `${serverId}/chat-images/${imageId}.webp`;
}

// SSRF guard for the from-url path: only public http(s) URLs may be fetched server-side. Rejects other
// schemes and any loopback / private / link-local host so a member can't point the Worker at an internal
// address. Cloudflare Workers can't reach the user's LAN (they run on the edge), but this is defence in
// depth + blocks obvious internal hostnames.
const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fc|\[?fd|0\.0\.0\.0)/i;
function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !PRIVATE_HOST_RE.test(url.hostname);
}

// Fetch remote image bytes with a hard timeout, content-type gate and size cap. Returns the bytes +
// their content-type, or null on any failure (non-2xx, non-image, oversize, timeout, network error).
async function fetchRemoteImage(
  url: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "image/*" },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > LIMITS.chatImageMaxBytes) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > LIMITS.chatImageMaxBytes) return null;
    return { bytes, contentType: contentType.split(";")[0]?.trim() ?? "application/octet-stream" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const chatImagesRoute = new Hono<{ Bindings: Env; Variables: MemberVars }>();

// POST /api/servers/:id/chat-images (member): stream one pasted image (image/*, ≤ chatImageMaxBytes) to
// R2 and return its id. Rejects a wrong content-type (415), an empty body (400) or an oversize body (413).
chatImagesRoute.post("/:id/chat-images", requireMember, async (c) => {
  // requireMember guarantees a resolved member; the userId is not persisted here (the chat.send row
  // records authorship), but the gate keeps non-members from writing bytes into the server's prefix.
  invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "unsupported_media" satisfies ErrorCode }, 415);
  }
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }
  if (bytes.byteLength > LIMITS.chatImageMaxBytes) {
    return c.json({ error: "payload_too_large" satisfies ErrorCode }, 413);
  }

  const imageId = crypto.randomUUID();
  await c.env.MEDIA.put(r2Key(serverId, imageId), bytes, {
    httpMetadata: { contentType: "image/webp" },
  });
  return c.json(CreateChatImageResponse.parse({ id: imageId }));
});

// POST /api/servers/:id/chat-images/from-url (member): ingest an image the client could only drop as a
// URL (no file bytes). The WORKER fetches it — so the browser never makes a cross-origin request — then
// stores the bytes in R2 with their source content-type and returns the id. SSRF-guarded + size-capped.
chatImagesRoute.post("/:id/chat-images/from-url", requireMember, async (c) => {
  invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;

  const parsed = ChatImageFromUrlRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }
  if (!isPublicHttpUrl(parsed.data.url)) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }

  const fetched = await fetchRemoteImage(parsed.data.url);
  if (fetched === null) {
    // Upstream refused / wasn't an image / too big / timed out — nothing to store.
    return c.json({ error: "unsupported_media" satisfies ErrorCode }, 422);
  }

  const imageId = crypto.randomUUID();
  await c.env.MEDIA.put(r2Key(serverId, imageId), fetched.bytes, {
    httpMetadata: { contentType: fetched.contentType },
  });
  return c.json(CreateChatImageResponse.parse({ id: imageId }));
});
