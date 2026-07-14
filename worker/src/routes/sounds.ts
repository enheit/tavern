import { Hono } from "hono";
import { z } from "zod";
import { parseBuffer } from "music-metadata";
import {
  ApiErrorBody,
  LIMITS,
  PatchSoundRequest,
  ReactionEmoji,
  SoundResponse,
  SoundsResponse,
} from "@tavern/shared";
import type { ErrorCode } from "@tavern/shared";
import { requireMember, zodJson } from "../middleware";
import type { MemberVars } from "../middleware";
import {
  recordMediaObject,
  removeMediaObject,
  trackMediaInventory,
} from "../lib/mediaUsageInventory";

// §3.7 contingency flag. music-metadata is verified working under workerd (S9.1 smoke parsed the
// beep.mp3 duration), so validation runs in `full` mode: the server computes durationMs from the file
// bytes. If a future workerd breaks music-metadata (import error / runtime crash), flip this to
// "basic" — the route then trusts the client-measured `durationMs` form field (still bounds-checked).
const SOUND_VALIDATION_MODE: "full" | "basic" = "full";

// Non-null narrow without `!` (§9.1): mirrors the helper in routes/servers.ts.
function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// mp3 magic-byte sniff (task 3b): an ID3v2 tag ("ID3") OR a raw MPEG frame sync (0xFF then the top 3
// bits of the next byte all set). Anything else is rejected 415 before any parse/put.
function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return true;
  return false;
}

// ErrorCode → the HTTP status the route returns (both its own validation codes and the ones forwarded
// from the DO). Every branch is a ContentfulStatusCode literal so Hono's c.json stays typed (no cast).
function statusFor(code: ErrorCode): 400 | 403 | 404 | 413 | 415 | 422 | 429 {
  switch (code) {
    case "payload_too_large":
      return 413;
    case "unsupported_media":
      return 415;
    case "sound_too_long":
    case "bad_trim":
      return 422;
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

function doStub(env: Env, serverId: string): DurableObjectStub {
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
}

// The Worker resolves admin from D1 (servers.admin_user_id) and passes it as the actor for a
// patch/delete; the uploader-or-admin check itself lives in the DO (soundboard module).
async function resolveIsAdmin(env: Env, serverId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT admin_user_id FROM servers WHERE id = ?")
    .bind(serverId)
    .first<{ admin_user_id: string }>();
  return row !== null && row.admin_user_id === userId;
}

// Internal-call headers; X-Tavern-Admin mirrors the resolved privilege on the wire per task 2 (the DO
// reads the authoritative `actor` from the body, so both derive from the same resolved boolean).
function internalHeaders(isAdmin: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    "X-Tavern-Internal": "1",
    ...(isAdmin ? { "X-Tavern-Admin": "1" } : {}),
  };
}

const soundUploadFields = z
  .object({
    name: z.string().min(1).max(LIMITS.soundNameMax),
    emoji: ReactionEmoji,
    gain: z.coerce.number().min(LIMITS.soundGainMin).max(LIMITS.soundGainMax),
    durationMs: z.coerce.number().int().positive(),
    trimStartRatio: z.coerce.number().min(0).max(1),
    trimEndRatio: z.coerce.number().min(0).max(1),
  })
  .refine((value) => value.trimStartRatio < value.trimEndRatio, { message: "bad_trim" });

type ParsedSoundUpload = {
  bytes: Uint8Array;
  name: string;
  emoji: string;
  gain: number;
  sourceFileName: string;
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number;
};

type SoundUploadFailure = {
  error: ErrorCode;
  status: 400 | 413 | 415 | 422;
};

async function parseSoundUpload(request: Request): Promise<ParsedSoundUpload | SoundUploadFailure> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    Number(declared) > LIMITS.soundMaxBytes + LIMITS.soundMultipartOverheadBytes
  ) {
    return { error: "payload_too_large", status: 413 };
  }
  const form = await request.formData();
  const file = form.get("file");
  const fields = soundUploadFields.safeParse({
    name: form.get("name"),
    emoji: form.get("emoji"),
    gain: form.get("gain"),
    durationMs: form.get("durationMs"),
    trimStartRatio: form.get("trimStartRatio"),
    trimEndRatio: form.get("trimEndRatio"),
  });
  if (!(file instanceof File) || !fields.success) return { error: "bad_request", status: 400 };
  if (file.name.length < 1 || file.name.length > LIMITS.soundFileNameMax) {
    return { error: "bad_request", status: 400 };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > LIMITS.soundMaxBytes) {
    return { error: "payload_too_large", status: 413 };
  }
  if (!looksLikeMp3(bytes)) return { error: "unsupported_media", status: 415 };

  let durationMs = fields.data.durationMs;
  if (SOUND_VALIDATION_MODE === "full") {
    const meta = await parseBuffer(bytes, undefined, { duration: true });
    const seconds = meta.format.duration;
    if (typeof seconds !== "number" || Number.isNaN(seconds)) {
      return { error: "unsupported_media", status: 415 };
    }
    durationMs = Math.round(seconds * 1000);
  }
  if (durationMs > LIMITS.soundMaxDurationMs) {
    return { error: "sound_too_long", status: 422 };
  }
  const trimStartMs = Math.round(durationMs * fields.data.trimStartRatio);
  const trimEndMs =
    fields.data.trimEndRatio === 1 ? durationMs : Math.round(durationMs * fields.data.trimEndRatio);
  if (trimEndMs - trimStartMs < LIMITS.soundMinTrimMs) {
    return { error: "bad_trim", status: 422 };
  }
  return {
    bytes,
    name: fields.data.name,
    emoji: fields.data.emoji,
    gain: fields.data.gain,
    sourceFileName: file.name,
    durationMs,
    trimStartMs,
    trimEndMs,
  };
}

export const soundsRoute = new Hono<{ Bindings: Env; Variables: MemberVars }>();

// GET /api/servers/:id/sounds (FR-34/37): member-gated list proxied to the DO, validated against the
// shared SoundsResponse (§9.8 at the DO→Worker boundary).
soundsRoute.get("/:id/sounds", requireMember, async (c) => {
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
  const stub = doStub(c.env, c.var.serverId);
  const res = await stub.fetch(`https://do.internal/internal/sounds?${params.toString()}`, {
    headers: { "X-Tavern-Internal": "1" },
  });
  const body: unknown = await res.json();
  return c.json(SoundsResponse.parse(body));
});

// POST /api/servers/:id/sounds (FR-34): multipart upload. Validation chain is fail-fast in the pinned
// order — content-length, magic bytes, duration — then R2 put + DO create. A rate-limit / bad create
// deletes the just-put object so no orphan remains.
soundsRoute.post("/:id/sounds", requireMember, async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const parsed = await parseSoundUpload(c.req.raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status);

  // (d) Persist the object, then register it in the DO. On create trim spans the whole clip.
  const soundId = crypto.randomUUID();
  const r2Key = `sounds/${serverId}/${soundId}.mp3`;
  const object = await c.env.MEDIA.put(r2Key, parsed.bytes, {
    httpMetadata: { contentType: "audio/mpeg" },
  });
  c.executionCtx.waitUntil(trackMediaInventory(recordMediaObject(c.env.DB, object), "put", r2Key));

  const sound = {
    id: soundId,
    name: parsed.name,
    emoji: parsed.emoji,
    gain: parsed.gain,
    sourceFileName: parsed.sourceFileName,
    uploaderId: userId,
    durationMs: parsed.durationMs,
    trimStartMs: parsed.trimStartMs,
    trimEndMs: parsed.trimEndMs,
    createdAt: Date.now(),
  };
  const stub = doStub(c.env, serverId);
  const res = await stub.fetch("https://do.internal/internal/sounds/create", {
    method: "POST",
    headers: internalHeaders(false),
    body: JSON.stringify({ sound, r2Key }),
  });
  if (!res.ok) {
    // rate_limited (or a rejected create) → drop the just-put object so no orphan remains (task 4).
    await c.env.MEDIA.delete(r2Key);
    c.executionCtx.waitUntil(
      trackMediaInventory(removeMediaObject(c.env.DB, r2Key), "delete", r2Key),
    );
    const code = ApiErrorBody.parse(await res.json()).error;
    return c.json({ error: code }, statusFor(code));
  }
  const created = SoundResponse.parse(await res.json());
  return c.json({ sound: created.sound }, 201);
});

// PATCH /api/servers/:id/sounds/:soundId (FR-35): rename / trim; uploader-or-admin (enforced in the
// DO from the forwarded actor). zodJson already rejected an empty / malformed body with 400.
soundsRoute.patch("/:id/sounds/:soundId", requireMember, zodJson(PatchSoundRequest), async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const soundId = invariant(c.req.param("soundId"), "route guarantees :soundId");
  const patch = PatchSoundRequest.parse(await c.req.json());
  const isAdmin = await resolveIsAdmin(c.env, serverId, userId);

  const stub = doStub(c.env, serverId);
  const res = await stub.fetch("https://do.internal/internal/sounds/patch", {
    method: "POST",
    headers: internalHeaders(isAdmin),
    body: JSON.stringify({ soundId, patch, actor: { userId, isAdmin } }),
  });
  if (!res.ok) {
    const code = ApiErrorBody.parse(await res.json()).error;
    return c.json({ error: code }, statusFor(code));
  }
  const patched = SoundResponse.parse(await res.json());
  return c.json({ sound: patched.sound });
});

// PUT /api/servers/:id/sounds/:soundId/source: replace the original MP3 and all editable metadata in
// one save. The new id makes the media URL immutable; the DO preserves uploader/createdAt and clears
// the old play history only after the staged R2 object exists.
soundsRoute.put("/:id/sounds/:soundId/source", requireMember, async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const soundId = invariant(c.req.param("soundId"), "route guarantees :soundId");
  const parsed = await parseSoundUpload(c.req.raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status);
  const isAdmin = await resolveIsAdmin(c.env, serverId, userId);
  const replacementId = crypto.randomUUID();
  const r2Key = `sounds/${serverId}/${replacementId}.mp3`;
  const object = await c.env.MEDIA.put(r2Key, parsed.bytes, {
    httpMetadata: { contentType: "audio/mpeg" },
  });
  c.executionCtx.waitUntil(trackMediaInventory(recordMediaObject(c.env.DB, object), "put", r2Key));
  const replacement = {
    id: replacementId,
    name: parsed.name,
    emoji: parsed.emoji,
    gain: parsed.gain,
    sourceFileName: parsed.sourceFileName,
    durationMs: parsed.durationMs,
    trimStartMs: parsed.trimStartMs,
    trimEndMs: parsed.trimEndMs,
  };
  const stub = doStub(c.env, serverId);
  const res = await stub.fetch("https://do.internal/internal/sounds/replace", {
    method: "POST",
    headers: internalHeaders(isAdmin),
    body: JSON.stringify({
      soundId,
      replacement,
      r2Key,
      actor: { userId, isAdmin },
    }),
  });
  if (!res.ok) {
    await c.env.MEDIA.delete(r2Key);
    c.executionCtx.waitUntil(
      trackMediaInventory(removeMediaObject(c.env.DB, r2Key), "delete", r2Key),
    );
    const code = ApiErrorBody.parse(await res.json()).error;
    return c.json({ error: code }, statusFor(code));
  }
  return c.json(SoundResponse.parse(await res.json()));
});

// DELETE /api/servers/:id/sounds/:soundId (FR-35): uploader-or-admin. The DO deletes metadata/history,
// queues the immutable R2 asset for retryable cleanup, and the route returns 204.
soundsRoute.delete("/:id/sounds/:soundId", requireMember, async (c) => {
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const serverId = c.var.serverId;
  const soundId = invariant(c.req.param("soundId"), "route guarantees :soundId");
  const isAdmin = await resolveIsAdmin(c.env, serverId, userId);

  const stub = doStub(c.env, serverId);
  const res = await stub.fetch("https://do.internal/internal/sounds/delete", {
    method: "POST",
    headers: internalHeaders(isAdmin),
    body: JSON.stringify({ soundId, actor: { userId, isAdmin } }),
  });
  if (!res.ok) {
    const code = ApiErrorBody.parse(await res.json()).error;
    return c.json({ error: code }, statusFor(code));
  }
  return c.body(null, 204);
});
