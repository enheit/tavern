import { LIMITS, Sound } from "@tavern/shared";
import type { ErrorCode } from "@tavern/shared";

// A typed error carrying a shared ErrorCode. The ServerRoom's sounds dispatch catches it and maps the
// code to the HTTP status the Worker route forwards (bad_trim→422, forbidden→403, not_found→404).
export class TavernError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.name = "TavernError";
    this.code = code;
  }
}

// The uploader-or-admin identity for a patch/delete (resolved by the Worker from D1's admin_user_id).
export type Actor = { userId: string; isAdmin: boolean };
// Optionals carry `| undefined` to match the zod-parsed boundary shape under exactOptionalPropertyTypes.
export type SoundPatch = {
  name?: string | undefined;
  trimStartMs?: number | undefined;
  trimEndMs?: number | undefined;
};

// One `sounds` row joined with its play count (COUNT over sound_plays); read-back validated with the
// shared `Sound` schema (§9.8 / A9: SQL read-back is a trust boundary).
type SoundRow = Record<string, SqlStorageValue>;

function rowToSound(row: SoundRow): Sound {
  return Sound.parse({
    id: String(row["id"]),
    name: String(row["name"]),
    uploaderId: String(row["uploader_id"]),
    durationMs: Number(row["duration_ms"]),
    trimStartMs: Number(row["trim_start_ms"]),
    trimEndMs: Number(row["trim_end_ms"]),
    createdAt: Number(row["created_at"]),
    playCount: Number(row["play_count"]),
  });
}

// Trim invariant (pinned): 0 ≤ start < end ≤ duration AND end − start ≥ soundMinTrimMs. Enforced on
// create + patch; a violation throws bad_trim (→ 422). A very short clip (<200ms) fails this on create.
function assertTrim(startMs: number, endMs: number, durationMs: number): void {
  const ok =
    startMs >= 0 &&
    startMs < endMs &&
    endMs <= durationMs &&
    endMs - startMs >= LIMITS.soundMinTrimMs;
  if (!ok) throw new TavernError("bad_trim");
}

// FR-37 ordering: most-played first, newest (createdAt DESC) as the tiebreak. playCount is derived
// (COUNT of sound_plays) — §5.2 keeps the detail rows, v1 surfaces only the count + ordering.
export function listSounds(sql: SqlStorage): Sound[] {
  return sql
    .exec<SoundRow>(
      `SELECT s.id, s.name, s.uploader_id, s.duration_ms, s.trim_start_ms, s.trim_end_ms,
              s.created_at, COUNT(p.id) AS play_count
       FROM sounds s LEFT JOIN sound_plays p ON p.sound_id = s.id
       GROUP BY s.id
       ORDER BY play_count DESC, s.created_at DESC`,
    )
    .toArray()
    .map(rowToSound);
}

// One sound with its derived play count, or null when absent.
function getSound(sql: SqlStorage, soundId: string): Sound | null {
  const rows = sql
    .exec<SoundRow>(
      `SELECT s.id, s.name, s.uploader_id, s.duration_ms, s.trim_start_ms, s.trim_end_ms,
              s.created_at, COUNT(p.id) AS play_count
       FROM sounds s LEFT JOIN sound_plays p ON p.sound_id = s.id
       WHERE s.id = ? GROUP BY s.id`,
      soundId,
    )
    .toArray();
  const row = rows[0];
  return row === undefined ? null : rowToSound(row);
}

// The stored uploader + r2 key of a sound (the columns the Sound wire type omits) — used to authorize
// a patch/delete and to hand the R2 key back to the Worker for object deletion.
function getOwner(sql: SqlStorage, soundId: string): { uploaderId: string; r2Key: string } | null {
  const rows = sql
    .exec<SoundRow>(`SELECT uploader_id, r2_key FROM sounds WHERE id = ?`, soundId)
    .toArray();
  const row = rows[0];
  if (row === undefined) return null;
  return { uploaderId: String(row["uploader_id"]), r2Key: String(row["r2_key"]) };
}

// Only the uploader (or an admin) may edit/delete their sound (FR-35). Throws forbidden otherwise.
function assertActor(uploaderId: string, actor: Actor): void {
  if (uploaderId !== actor.userId && !actor.isAdmin) throw new TavernError("forbidden");
}

// Inserts a new sound row. On create trimStart = 0 and trimEnd = durationMs (set by the caller); the
// trim invariant is still checked (a sub-200ms clip is rejected). `r2Key` is the stored `sounds/{server
// }/{id}.mp3` object key (the §5.2 DDL requires it NOT NULL; deleteSound hands it back for R2 cleanup).
export function createSound(sql: SqlStorage, s: Omit<Sound, "playCount">, r2Key: string): Sound {
  assertTrim(s.trimStartMs, s.trimEndMs, s.durationMs);
  sql.exec(
    `INSERT INTO sounds (id, name, uploader_id, r2_key, duration_ms, trim_start_ms, trim_end_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id,
    s.name,
    s.uploaderId,
    r2Key,
    s.durationMs,
    s.trimStartMs,
    s.trimEndMs,
    s.createdAt,
  );
  return { ...s, playCount: 0 };
}

// Renames and/or re-trims a sound (FR-35). Uploader-or-admin only. A trim change re-checks the pinned
// invariant against the stored durationMs. Throws not_found / forbidden / bad_trim.
export function patchSound(
  sql: SqlStorage,
  soundId: string,
  patch: SoundPatch,
  actor: Actor,
): Sound {
  const existing = getSound(sql, soundId);
  if (existing === null) throw new TavernError("not_found");
  assertActor(existing.uploaderId, actor);
  const name = patch.name ?? existing.name;
  const trimStartMs = patch.trimStartMs ?? existing.trimStartMs;
  const trimEndMs = patch.trimEndMs ?? existing.trimEndMs;
  assertTrim(trimStartMs, trimEndMs, existing.durationMs);
  sql.exec(
    `UPDATE sounds SET name = ?, trim_start_ms = ?, trim_end_ms = ? WHERE id = ?`,
    name,
    trimStartMs,
    trimEndMs,
    soundId,
  );
  return { ...existing, name, trimStartMs, trimEndMs };
}

// Deletes a sound row (FR-35). Uploader-or-admin only. Returns the stored R2 key so the Worker can
// delete the object. Throws not_found / forbidden.
export function deleteSound(sql: SqlStorage, soundId: string, actor: Actor): { r2Key: string } {
  const owner = getOwner(sql, soundId);
  if (owner === null) throw new TavernError("not_found");
  assertActor(owner.uploaderId, actor);
  sql.exec(`DELETE FROM sounds WHERE id = ?`, soundId);
  return { r2Key: owner.r2Key };
}
