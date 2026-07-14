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
  emoji?: string | undefined;
  gain?: number | undefined;
  trimStartMs?: number | undefined;
  trimEndMs?: number | undefined;
};

export type SoundReplacement = Pick<
  Sound,
  "id" | "name" | "emoji" | "gain" | "sourceFileName" | "durationMs" | "trimStartMs" | "trimEndMs"
>;

// One `sounds` row joined with its play count (COUNT over sound_plays); read-back validated with the
// shared `Sound` schema (§9.8 / A9: SQL read-back is a trust boundary).
type SoundRow = Record<string, SqlStorageValue>;

function rowToSound(row: SoundRow): Sound {
  return Sound.parse({
    id: String(row["id"]),
    name: String(row["name"]),
    emoji: String(row["emoji"]),
    gain: Number(row["gain"]),
    sourceFileName: String(row["source_file_name"]),
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
      `SELECT s.id, s.name, s.emoji, s.gain, s.source_file_name, s.uploader_id,
              s.duration_ms, s.trim_start_ms, s.trim_end_ms,
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
      `SELECT s.id, s.name, s.emoji, s.gain, s.source_file_name, s.uploader_id,
              s.duration_ms, s.trim_start_ms, s.trim_end_ms,
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
    `INSERT INTO sounds (
       id, name, emoji, gain, source_file_name, uploader_id, r2_key,
       duration_ms, trim_start_ms, trim_end_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id,
    s.name,
    s.emoji,
    s.gain,
    s.sourceFileName,
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
  const emoji = patch.emoji ?? existing.emoji;
  const gain = patch.gain ?? existing.gain;
  const trimStartMs = patch.trimStartMs ?? existing.trimStartMs;
  const trimEndMs = patch.trimEndMs ?? existing.trimEndMs;
  assertTrim(trimStartMs, trimEndMs, existing.durationMs);
  sql.exec(
    `UPDATE sounds SET name = ?, emoji = ?, gain = ?, trim_start_ms = ?, trim_end_ms = ? WHERE id = ?`,
    name,
    emoji,
    gain,
    trimStartMs,
    trimEndMs,
    soundId,
  );
  return { ...existing, name, emoji, gain, trimStartMs, trimEndMs };
}

// A source-file replacement is a new immutable media identity so Cache API entries can never serve
// the previous MP3. The tile keeps its uploader/createdAt, while the new id naturally resets history.
// The caller wraps this function in storage.transactionSync so insert/delete/cleanup enqueue commit as
// one SQLite operation.
export function replaceSound(
  sql: SqlStorage,
  soundId: string,
  replacement: SoundReplacement,
  r2Key: string,
  actor: Actor,
): Sound {
  const existing = getSound(sql, soundId);
  if (existing === null) throw new TavernError("not_found");
  assertActor(existing.uploaderId, actor);
  assertTrim(replacement.trimStartMs, replacement.trimEndMs, replacement.durationMs);
  const owner = getOwner(sql, soundId);
  if (owner === null) throw new TavernError("not_found");
  const next: Omit<Sound, "playCount"> = {
    ...replacement,
    uploaderId: existing.uploaderId,
    createdAt: existing.createdAt,
  };
  createSound(sql, next, r2Key);
  sql.exec(`DELETE FROM sound_plays WHERE sound_id = ?`, soundId);
  sql.exec(`DELETE FROM active_sound_plays WHERE sound_id = ?`, soundId);
  sql.exec(`DELETE FROM sounds WHERE id = ?`, soundId);
  sql.exec(`INSERT OR IGNORE INTO sound_asset_cleanup(r2_key) VALUES (?)`, owner.r2Key);
  return { ...next, playCount: 0 };
}

// Deletes a sound row (FR-35). Uploader-or-admin only. Returns the stored R2 key so the Worker can
// delete the object. Throws not_found / forbidden.
export function deleteSound(sql: SqlStorage, soundId: string, actor: Actor): { r2Key: string } {
  const owner = getOwner(sql, soundId);
  if (owner === null) throw new TavernError("not_found");
  assertActor(owner.uploaderId, actor);
  sql.exec(`DELETE FROM sound_plays WHERE sound_id = ?`, soundId);
  sql.exec(`DELETE FROM active_sound_plays WHERE sound_id = ?`, soundId);
  sql.exec(`DELETE FROM sounds WHERE id = ?`, soundId);
  sql.exec(`INSERT OR IGNORE INTO sound_asset_cleanup(r2_key) VALUES (?)`, owner.r2Key);
  return { r2Key: owner.r2Key };
}

// FR-36 playback trims for a `sound.played` broadcast — null when the sound is gone (also serves as the
// `sound.play` existence guard: unknown soundId → not_found). Sent in the frame so every in-voice client
// plays without the panel.
export function getSoundPlayback(
  sql: SqlStorage,
  soundId: string,
): { trimStartMs: number; trimEndMs: number; gain: number } | null {
  const row = sql
    .exec<SoundRow>(
      `SELECT trim_start_ms, trim_end_ms, gain FROM sounds WHERE id = ? LIMIT 1`,
      soundId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return {
    trimStartMs: Number(row["trim_start_ms"]),
    trimEndMs: Number(row["trim_end_ms"]),
    gain: Number(row["gain"]),
  };
}

// Atomically claims the room-wide playback slot for one sound. SQLite ownership makes the invariant
// survive Durable Object WebSocket hibernation; an expired row is replaced by the next accepted play.
export function claimSoundPlayback(
  sql: SqlStorage,
  soundId: string,
  startedAt: number,
  durationMs: number,
): boolean {
  const row = sql
    .exec<{ ends_at: number }>(
      `SELECT ends_at FROM active_sound_plays WHERE sound_id = ? LIMIT 1`,
      soundId,
    )
    .toArray()[0];
  if (row !== undefined && Number(row.ends_at) > startedAt) return false;
  sql.exec(
    `INSERT INTO active_sound_plays(sound_id, ends_at) VALUES (?, ?)
       ON CONFLICT(sound_id) DO UPDATE SET ends_at = excluded.ends_at`,
    soundId,
    startedAt + durationMs,
  );
  return true;
}

export function releaseSoundPlayback(sql: SqlStorage, soundId: string): void {
  sql.exec(`DELETE FROM active_sound_plays WHERE sound_id = ?`, soundId);
}

export function pendingSoundAssetCleanup(sql: SqlStorage): string[] {
  return sql
    .exec<SoundRow>(`SELECT r2_key FROM sound_asset_cleanup ORDER BY r2_key`)
    .toArray()
    .map((row) => String(row["r2_key"]));
}

export function completeSoundAssetCleanup(sql: SqlStorage, r2Key: string): void {
  sql.exec(`DELETE FROM sound_asset_cleanup WHERE r2_key = ?`, r2Key);
}

// Records one play (FR-36/37): appends a `sound_plays` detail row (who/when RETAINED per §5.2). The
// surfaced `playCount` is derived (COUNT of sound_plays), so this row is what bumps the ordering/badge.
export function recordPlay(sql: SqlStorage, soundId: string, userId: string, at: number): void {
  sql.exec(
    `INSERT INTO sound_plays (sound_id, user_id, created_at) VALUES (?, ?, ?)`,
    soundId,
    userId,
    at,
  );
}
