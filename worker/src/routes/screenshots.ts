import { Hono } from "hono";
import { z } from "zod";
import {
  CreateScreenshotResponse,
  errorCodeSchema,
  LIMITS,
  ScreenshotsResponse,
} from "@tavern/shared";
import type { ErrorCode } from "@tavern/shared";
import { requireMember } from "../middleware";
import type { MemberVars } from "../middleware";
import {
  recordMediaObject,
  removeMediaObject,
  trackMediaInventory,
} from "../lib/mediaUsageInventory";

// § screenshots routes (§6.1). A screenshot is a single still frame a member captured from the focused
// stream. The image bytes are a small single PUT (no multipart, unlike recordings): the Worker streams
// the body to R2, then the DO owns the registry row + the capture rate limit + the broadcast. The
// deterministic R2 key is server-first per the pinned layout `{serverId}/screenshots/{id}.webp` — the
// same two-UUID path the PUBLIC view route (routes/screenshotView.ts) serves as a capability URL.

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

// The deterministic R2 key (server-first layout). The client never learns it; the Worker builds it.
function r2Key(serverId: string, screenshotId: string): string {
  return `${serverId}/screenshots/${screenshotId}.webp`;
}

// ErrorCode → the HTTP status the route returns for a DO authorization / validation failure.
function statusFor(code: ErrorCode): 400 | 403 | 404 | 429 {
  switch (code) {
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    default:
      return 400;
  }
}

// Structural parsers for the DO internal responses.
const deleteOk = z.object({ r2Key: z.string() });
const failure = z.object({ error: errorCodeSchema });

function failureCode(body: unknown): ErrorCode {
  const parsed = failure.safeParse(body);
  return parsed.success ? parsed.data.error : "bad_request";
}

async function resolveIsAdmin(env: Env, serverId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT admin_user_id FROM servers WHERE id = ?")
    .bind(serverId)
    .first<{ admin_user_id: string }>();
  return row !== null && row.admin_user_id === userId;
}

export const screenshotsRoute = new Hono<{ Bindings: Env; Variables: MemberVars }>();

// GET /api/servers/:id/screenshots (§ screenshots tab): member-gated list, newest first.
screenshotsRoute.get("/:id/screenshots", requireMember, async (c) => {
  const query = z
    .object({
      offset: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().positive().optional(),
    })
    .safeParse({ offset: c.req.query("offset"), limit: c.req.query("limit") });
  if (!query.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const params = new URLSearchParams();
  if (query.data.offset !== undefined) params.set("offset", String(query.data.offset));
  if (query.data.limit !== undefined) params.set("limit", String(query.data.limit));
  const res = await doStub(c.env, c.var.serverId).fetch(
    `https://do.internal/internal/screenshots?${params.toString()}`,
    { headers: { "X-Tavern-Internal": "1" } },
  );
  return c.json(ScreenshotsResponse.parse(await res.json()));
});

// POST /api/servers/:id/screenshots (member): stream one captured still (image/*, ≤ screenshotMaxBytes)
// to R2, then register the row via the DO. A DO rate-limit reject deletes the just-PUT object.
screenshotsRoute.post("/:id/screenshots", requireMember, async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "unsupported_media" satisfies ErrorCode }, 415);
  }
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }
  if (bytes.byteLength > LIMITS.screenshotMaxBytes) {
    return c.json({ error: "payload_too_large" satisfies ErrorCode }, 413);
  }

  const screenshotId = crypto.randomUUID();
  const key = r2Key(serverId, screenshotId);
  const object = await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/webp" } });
  c.executionCtx.waitUntil(trackMediaInventory(recordMediaObject(c.env.DB, object), "put", key));

  const res = await internalPost(c.env, serverId, "/internal/screenshots/create", {
    userId,
    screenshotId,
    r2Key: key,
  });
  const body: unknown = await res.json();
  const ok = CreateScreenshotResponse.safeParse(body);
  if (!ok.success) {
    // The DO refused the row (rate limit) — drop the orphaned object so R2 doesn't accrue dead bytes.
    await c.env.MEDIA.delete(key);
    c.executionCtx.waitUntil(trackMediaInventory(removeMediaObject(c.env.DB, key), "delete", key));
    const code = failureCode(body);
    return c.json({ error: code }, statusFor(code));
  }
  return c.json(ok.data);
});

// DELETE /api/servers/:id/screenshots/:sid (capturer/admin): row delete + R2 object delete.
screenshotsRoute.delete("/:id/screenshots/:sid", requireMember, async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const screenshotId = invariant(c.req.param("sid"), "route guarantees :sid");
  const isAdmin = await resolveIsAdmin(c.env, serverId, userId);
  const res = await internalPost(c.env, serverId, "/internal/screenshots/delete", {
    userId,
    isAdmin,
    screenshotId,
  });
  const body: unknown = await res.json();
  const ok = deleteOk.safeParse(body);
  if (!ok.success) {
    const code = failureCode(body);
    return c.json({ error: code }, statusFor(code));
  }
  await c.env.MEDIA.delete(ok.data.r2Key);
  c.executionCtx.waitUntil(
    trackMediaInventory(removeMediaObject(c.env.DB, ok.data.r2Key), "delete", ok.data.r2Key),
  );
  return c.body(null, 204);
});
