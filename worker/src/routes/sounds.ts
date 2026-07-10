import { Hono } from "hono";
import { z } from "zod";
import { parseBuffer } from "music-metadata";
import { ApiErrorBody, LIMITS, PatchSoundRequest, Sound, SoundsResponse } from "@tavern/shared";
import type { ErrorCode } from "@tavern/shared";
import { requireMember, zodJson } from "../middleware";
import type { MemberVars } from "../middleware";

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

const deleteDoResponse = z.object({ r2Key: z.string() });
const soundDoResponse = z.object({ sound: Sound });

export const soundsRoute = new Hono<{ Bindings: Env; Variables: MemberVars }>();

// GET /api/servers/:id/sounds (FR-34/37): member-gated list proxied to the DO, validated against the
// shared SoundsResponse (§9.8 at the DO→Worker boundary).
soundsRoute.get("/:id/sounds", requireMember, async (c) => {
  const stub = doStub(c.env, c.var.serverId);
  const res = await stub.fetch("https://do.internal/internal/sounds", {
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

  // (a) Content-Length fast reject before reading the body.
  const declared = c.req.header("content-length");
  if (declared !== undefined && Number(declared) > LIMITS.soundMaxBytes) {
    return c.json({ error: "payload_too_large" satisfies ErrorCode }, 413);
  }

  const form = await c.req.formData();
  const file = form.get("file");
  const name = form.get("name");
  const durationRaw = form.get("durationMs");
  if (!(file instanceof File) || typeof name !== "string" || typeof durationRaw !== "string") {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }
  if (name.length < 1 || name.length > LIMITS.soundNameMax) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }
  const clientDurationMs = Number(durationRaw);
  if (!Number.isInteger(clientDurationMs) || clientDurationMs <= 0) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > LIMITS.soundMaxBytes) {
    return c.json({ error: "payload_too_large" satisfies ErrorCode }, 413);
  }
  // (b) Magic bytes.
  if (!looksLikeMp3(bytes)) {
    return c.json({ error: "unsupported_media" satisfies ErrorCode }, 415);
  }

  // (c) Duration: full mode computes it from the file (music-metadata); basic mode trusts the client.
  let durationMs = clientDurationMs;
  if (SOUND_VALIDATION_MODE === "full") {
    const meta = await parseBuffer(bytes, undefined, { duration: true });
    const seconds = meta.format.duration;
    if (typeof seconds !== "number" || Number.isNaN(seconds)) {
      return c.json({ error: "unsupported_media" satisfies ErrorCode }, 415);
    }
    // float seconds → whole ms (Math.round, matching the TrimDialog convention; schema wants z.int()).
    durationMs = Math.round(seconds * 1000);
  }
  if (durationMs > LIMITS.soundMaxDurationMs) {
    return c.json({ error: "sound_too_long" satisfies ErrorCode }, 422);
  }

  // (d) Persist the object, then register it in the DO. On create trim spans the whole clip.
  const soundId = crypto.randomUUID();
  const r2Key = `sounds/${serverId}/${soundId}.mp3`;
  await c.env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: "audio/mpeg" } });

  const sound = {
    id: soundId,
    name,
    uploaderId: userId,
    durationMs,
    trimStartMs: 0,
    trimEndMs: durationMs,
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
    const code = ApiErrorBody.parse(await res.json()).error;
    return c.json({ error: code }, statusFor(code));
  }
  const created = soundDoResponse.parse(await res.json());
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
  const patched = soundDoResponse.parse(await res.json());
  return c.json({ sound: patched.sound });
});

// DELETE /api/servers/:id/sounds/:soundId (FR-35): uploader-or-admin. The DO returns the stored R2 key
// (row deleted); the route deletes the object, then 204.
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
  const { r2Key } = deleteDoResponse.parse(await res.json());
  await c.env.MEDIA.delete(r2Key);
  return c.body(null, 204);
});
