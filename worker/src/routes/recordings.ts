import { Hono } from "hono";
import { z } from "zod";
import {
  CompleteRecordingRequest,
  errorCodeSchema,
  LIMITS,
  OpenRecordingResponse,
  RecordingsResponse,
  UploadPartResponse,
} from "@tavern/shared";
import type { ErrorCode } from "@tavern/shared";
import { requireMember, zodJson } from "../middleware";
import type { MemberVars } from "../middleware";

// FR-25 recording multipart routes (§6.1, §7.4). The client holds the R2 uploadId (Worker stays
// stateless across parts); the DO owns authorization + the multipart create/abort + the registry row.
// Only the PUT part route touches R2 here (it streams the ≥5 MiB body) — open/complete/abort/delete
// delegate the R2 op to the DO (small payloads) or derive the key deterministically.

// Non-null narrow without `!` (§9.1): mirrors routes/sounds.ts.
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

// The deterministic R2 key (§5.3) — the client never learns it; the Worker builds it from the path.
function r2Key(serverId: string, recordingId: string): string {
  return `recordings/${serverId}/${recordingId}.webm`;
}

// ErrorCode → the HTTP status the route returns for a DO authorization / validation failure.
function statusFor(code: ErrorCode): 400 | 403 | 404 | 422 {
  switch (code) {
    case "not_in_voice":
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "recording_too_long":
    case "bad_part_size":
      return 422;
    default:
      return 400;
  }
}

// Structural parsers for the DO internal responses (the { ok } envelopes from RecordingsModule).
const openOk = z.object({ ok: z.literal(true), recordingId: z.string(), uploadId: z.string() });
const resolveOk = z.object({
  ok: z.literal(true),
  uploadId: z.string(),
  r2Key: z.string(),
  startedAt: z.number(),
});
const mutateOk = z.object({ ok: z.literal(true) });
const deleteOk = z.object({ ok: z.literal(true), r2Key: z.string() });
const failure = z.object({ ok: z.literal(false), error: errorCodeSchema });

// Narrows a DO envelope to an ErrorCode failure (validated against the shared enum, so no cast).
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

export const recordingsRoute = new Hono<{ Bindings: Env; Variables: MemberVars }>();

// GET /api/servers/:id/recordings (FR-25): member-gated list (finalized, newest first).
recordingsRoute.get("/:id/recordings", requireMember, async (c) => {
  const res = await doStub(c.env, c.var.serverId).fetch("https://do.internal/internal/recordings", {
    headers: { "X-Tavern-Internal": "1" },
  });
  return c.json(RecordingsResponse.parse(await res.json()));
});

// POST /api/servers/:id/recordings (member-in-voice, active starter): open the R2 multipart.
recordingsRoute.post("/:id/recordings", requireMember, async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const res = await internalPost(c.env, c.var.serverId, "/internal/recordings/open", { userId });
  const body: unknown = await res.json();
  const ok = openOk.safeParse(body);
  if (!ok.success) {
    const code = failureCode(body);
    return c.json({ error: code }, statusFor(code));
  }
  return c.json(
    OpenRecordingResponse.parse({ recordingId: ok.data.recordingId, uploadId: ok.data.uploadId }),
  );
});

// PUT /api/servers/:id/recordings/:recId/part?n=&uploadId=&final= (starter): stream one part to R2.
recordingsRoute.put("/:id/recordings/:recId/part", requireMember, async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const recordingId = invariant(c.req.param("recId"), "route guarantees :recId");
  const n = Number(c.req.query("n"));
  const uploadId = c.req.query("uploadId");
  const final = c.req.query("final") === "1";
  if (!Number.isInteger(n) || n < 1 || uploadId === undefined) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }

  // Authorize (caller owns an in-flight row) + read started_at for the duration guard.
  const authRes = await internalPost(c.env, serverId, "/internal/recordings/resolve", {
    userId,
    recordingId,
  });
  const authBody: unknown = await authRes.json();
  const auth = resolveOk.safeParse(authBody);
  if (!auth.success) {
    const code = failureCode(authBody);
    return c.json({ error: code }, statusFor(code));
  }
  // Reject a recording that ran far past the cap (grace: +5 min over recordingMaxDurationMs).
  if (Date.now() - auth.data.startedAt > LIMITS.recordingMaxDurationMs + 300_000) {
    return c.json({ error: "recording_too_long" satisfies ErrorCode }, 422);
  }

  const bytes = await c.req.arrayBuffer();
  // Non-final parts must be EXACTLY recordingPartBytes (R2 multipart requires equal non-final parts).
  if (!final && bytes.byteLength !== LIMITS.recordingPartBytes) {
    return c.json({ error: "bad_part_size" satisfies ErrorCode }, 400);
  }
  const part = await c.env.MEDIA.resumeMultipartUpload(
    r2Key(serverId, recordingId),
    uploadId,
  ).uploadPart(n, bytes);
  return c.json(UploadPartResponse.parse({ etag: part.etag }));
});

// POST /api/servers/:id/recordings/:recId/complete (starter): R2 complete(parts) → DO finalize.
recordingsRoute.post(
  "/:id/recordings/:recId/complete",
  requireMember,
  zodJson(CompleteRecordingRequest),
  async (c) => {
    const userId = invariant(c.var.userId, "requireMember guarantees userId");
    const serverId = c.var.serverId;
    const recordingId = invariant(c.req.param("recId"), "route guarantees :recId");
    const input = CompleteRecordingRequest.parse(await c.req.json());

    const authRes = await internalPost(c.env, serverId, "/internal/recordings/resolve", {
      userId,
      recordingId,
    });
    const authBody: unknown = await authRes.json();
    const auth = resolveOk.safeParse(authBody);
    if (!auth.success) {
      const code = failureCode(authBody);
      return c.json({ error: code }, statusFor(code));
    }
    await c.env.MEDIA.resumeMultipartUpload(auth.data.r2Key, auth.data.uploadId).complete(
      input.parts,
    );
    const finRes = await internalPost(c.env, serverId, "/internal/recordings/finalize", {
      recordingId,
      durationMs: input.durationMs,
    });
    if (!mutateOk.safeParse(await finRes.json()).success) {
      return c.json({ error: "not_found" satisfies ErrorCode }, 404);
    }
    return c.body(null, 204);
  },
);

// POST /api/servers/:id/recordings/:recId/abort (starter): R2 abort + DO cancel path.
recordingsRoute.post("/:id/recordings/:recId/abort", requireMember, async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const recordingId = invariant(c.req.param("recId"), "route guarantees :recId");
  const res = await internalPost(c.env, c.var.serverId, "/internal/recordings/abort", {
    userId,
    recordingId,
  });
  const body: unknown = await res.json();
  if (!mutateOk.safeParse(body).success) {
    const code = failureCode(body);
    return c.json({ error: code }, statusFor(code));
  }
  return c.body(null, 204);
});

// DELETE /api/servers/:id/recordings/:recId (starter/admin): row delete + R2 object delete.
recordingsRoute.delete("/:id/recordings/:recId", requireMember, async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const recordingId = invariant(c.req.param("recId"), "route guarantees :recId");
  const isAdmin = await resolveIsAdmin(c.env, serverId, userId);
  const res = await internalPost(c.env, serverId, "/internal/recordings/delete", {
    userId,
    isAdmin,
    recordingId,
  });
  const body: unknown = await res.json();
  const ok = deleteOk.safeParse(body);
  if (!ok.success) {
    const code = failureCode(body);
    return c.json({ error: code }, statusFor(code));
  }
  await c.env.MEDIA.delete(ok.data.r2Key);
  return c.body(null, 204);
});
