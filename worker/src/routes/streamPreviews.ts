import { Hono } from "hono";
import { z } from "zod";
import { errorCodeSchema, LIMITS, PutStreamPreviewResponse, type ErrorCode } from "@tavern/shared";
import { requireMember, type MemberVars } from "../middleware";
import {
  recordMediaObject,
  removeMediaObject,
  trackMediaInventory,
} from "../lib/mediaUsageInventory";

const previewParams = z.object({ previewId: z.uuid() });
const authorizeResponse = z.union([
  z.object({ ok: z.literal(true), trackName: z.string(), preset: z.string() }),
  z.object({ ok: z.literal(false), error: errorCodeSchema }),
]);
const commitResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: errorCodeSchema }),
]);

function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function doStub(env: Env, serverId: string): DurableObjectStub {
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
}

function internalPost(env: Env, serverId: string, path: string, body: unknown): Promise<Response> {
  return doStub(env, serverId).fetch(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
    body: JSON.stringify(body),
  });
}

function r2Key(serverId: string, previewId: string): string {
  return `${serverId}/stream-previews/${previewId}.webp`;
}

function statusFor(code: ErrorCode): 400 | 403 | 404 | 429 {
  if (code === "forbidden") return 403;
  if (code === "not_found") return 404;
  if (code === "rate_limited") return 429;
  return 400;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const readNext = async (): Promise<boolean> => {
    const part = await reader.read();
    if (part.done) return true;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("stream preview exceeds byte limit");
      return false;
    }
    chunks.push(part.value);
    return readNext();
  };
  let complete: boolean;
  try {
    complete = await readNext();
  } finally {
    reader.releaseLock();
  }
  if (!complete) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

export const streamPreviewsRoute = new Hono<{ Bindings: Env; Variables: MemberVars }>();

streamPreviewsRoute.put("/:id/stream-previews/:previewId", requireMember, async (c) => {
  const params = previewParams.safeParse({ previewId: c.req.param("previewId") });
  if (!params.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  if ((c.req.header("content-type") ?? "").toLowerCase() !== "image/webp") {
    return c.json({ error: "unsupported_media" satisfies ErrorCode }, 415);
  }
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
    }
    if (parsedLength > LIMITS.streamPreviewMaxBytes) {
      return c.json({ error: "payload_too_large" satisfies ErrorCode }, 413);
    }
  }

  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const previewId = params.data.previewId;
  const authorization = authorizeResponse.parse(
    await (
      await internalPost(c.env, serverId, "/internal/stream-preview/authorize", {
        userId,
        previewId,
      })
    ).json(),
  );
  if (!authorization.ok) {
    return c.json({ error: authorization.error }, statusFor(authorization.error));
  }

  const bytes = await readBoundedBody(c.req.raw, LIMITS.streamPreviewMaxBytes);
  if (bytes === null) return c.json({ error: "payload_too_large" satisfies ErrorCode }, 413);
  if (!isWebp(bytes)) return c.json({ error: "unsupported_media" satisfies ErrorCode }, 415);

  const key = r2Key(serverId, previewId);
  const object = await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/webp" } });
  const committed = commitResponse.parse(
    await (
      await internalPost(c.env, serverId, "/internal/stream-preview/commit", {
        userId,
        previewId,
        version: object.version,
      })
    ).json(),
  );
  if (!committed.ok) {
    await c.env.MEDIA.delete(key);
    c.executionCtx.waitUntil(trackMediaInventory(removeMediaObject(c.env.DB, key), "delete", key));
    return c.json({ error: committed.error }, statusFor(committed.error));
  }

  c.executionCtx.waitUntil(trackMediaInventory(recordMediaObject(c.env.DB, object), "put", key));
  return c.json(
    PutStreamPreviewResponse.parse({ preview: { id: previewId, version: object.version } }),
  );
});

streamPreviewsRoute.get("/:id/stream-previews/:previewId", requireMember, async (c) => {
  const params = previewParams.safeParse({ previewId: c.req.param("previewId") });
  if (!params.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const object = await c.env.MEDIA.get(r2Key(c.var.serverId, params.data.previewId));
  if (object === null) return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "image/webp");
  headers.set("content-length", String(object.size));
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");
  return new Response(object.body, { headers });
});
