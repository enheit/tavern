import { LIMITS } from "@tavern/shared";
import type { ErrorCode, Recording, RecordingState, VoiceState } from "@tavern/shared";
import type { ActivityModule } from "./activity";
import type { RoomState } from "./roomState";

// FR-25 recording registry + state machine (§5.2 `recordings` table, §7.4). The DO is the single
// authority on the ONE active recording per server: the WS `rec.start`/`rec.stop` router calls
// `start`/`stop`; the disconnect/leave path calls `handleUserGone` (dirty-end abort); the Worker
// multipart routes reach `openMultipart`/`resolve`/`finalize`/`abort`/`remove`/`list` via internal
// routes. The active-recording pointer lives in ctx.storage KV (`recording`, survives hibernation);
// the durable registry rows live in SQLite. Broadcasts + activity rows go through RoomState/Activity.
//
// KV `recording` = the IN-PROGRESS session (set on rec.start, CLEARED on graceful rec.stop). A
// dirty-end (starter's last socket closes / leaves voice) only aborts while this pointer is still
// set — a prior rec.stop having cleared it means the row finalizes via the REST `complete` instead.

const CONTROL_KEY = "recording";
const MIME_KEY_SUFFIX = ".webm";

// The KV control record for the single active (recording-in-progress) session, or null when idle.
type Control = { recordingId: string; startedBy: string; startedAt: number };

// Result envelopes for the internal multipart routes (§6.1). `ok:false` carries the ErrorCode the
// Worker route forwards as the matching HTTP status.
export type OpenResult =
  | { ok: true; recordingId: string; uploadId: string }
  | { ok: false; error: ErrorCode };
export type ResolveResult =
  | { ok: true; uploadId: string; r2Key: string; startedAt: number }
  | { ok: false; error: ErrorCode };
export type MutateResult = { ok: true } | { ok: false; error: ErrorCode };
export type DeleteResult = { ok: true; r2Key: string } | { ok: false; error: ErrorCode };

interface RecordingsDeps {
  sql: SqlStorage;
  storage: DurableObjectStorage;
  media: R2Bucket;
  room: RoomState;
  activity: ActivityModule;
}

export class RecordingsModule {
  private readonly sql: SqlStorage;
  private readonly storage: DurableObjectStorage;
  private readonly media: R2Bucket;
  private readonly room: RoomState;
  private readonly activity: ActivityModule;
  // Synchronous mirror of the KV control record so `state()` feeds hello.ok without an await. Loaded
  // once from blockConcurrencyWhile, replaced on every mutation (each persisted by the mutator).
  private control: Control | null = null;

  constructor(deps: RecordingsDeps) {
    this.sql = deps.sql;
    this.storage = deps.storage;
    this.media = deps.media;
    this.room = deps.room;
    this.activity = deps.activity;
  }

  async load(): Promise<void> {
    this.control = (await this.storage.get<Control>(CONTROL_KEY)) ?? null;
  }

  // The hello.ok snapshot (§App-A RecordingState). Active while an in-progress session pointer exists.
  state(): RecordingState {
    if (this.control === null) return { active: false };
    return {
      active: true,
      recordingId: this.control.recordingId,
      startedBy: this.control.startedBy,
      startedAt: this.control.startedAt,
    };
  }

  private r2Key(recordingId: string): string {
    const serverId = this.room.serverId();
    return `recordings/${serverId ?? "unknown"}/${recordingId}${MIME_KEY_SUFFIX}`;
  }

  // Re-read the active pointer from KV (not the sync mirror) inside every async authorizer — the KV is
  // the truth across hibernation/eviction, and a test/producer can seed it straight into storage
  // (mirrors the rtc-authorize KV re-read, §S3.1 known issue). The mirror only feeds the sync `state()`.
  private async readControl(): Promise<Control | null> {
    return (await this.storage.get<Control>(CONTROL_KEY)) ?? null;
  }

  private async isInVoice(userId: string): Promise<boolean> {
    const voice = await this.storage.get<VoiceState>("voice");
    return (voice?.members ?? []).some((m) => m.userId === userId);
  }

  private async setControl(next: Control | null): Promise<void> {
    this.control = next;
    if (next === null) await this.storage.delete(CONTROL_KEY);
    else await this.storage.put(CONTROL_KEY, next);
  }

  // WS `rec.start`: the sender must be in voice, and no recording may already be active. Inserts the
  // registry row (upload_id NULL until the first part opens the multipart), sets the active pointer,
  // broadcasts `rec.state{active}`, appends `rec.start` activity. Returns the error code or null.
  async start(userId: string, now: number): Promise<ErrorCode | null> {
    if (!(await this.isInVoice(userId))) return "not_in_voice";
    if ((await this.readControl()) !== null) return "already_recording";
    const recordingId = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO recordings (id, started_by, r2_key, upload_id, duration_ms, started_at, ended_at)
       VALUES (?, ?, ?, NULL, NULL, ?, NULL)`,
      recordingId,
      userId,
      this.r2Key(recordingId),
      now,
    );
    await this.setControl({ recordingId, startedBy: userId, startedAt: now });
    this.room.broadcast({ t: "rec.state", recording: this.state(), at: now });
    this.room.broadcast({
      t: "activity.new",
      entry: this.activity.append("rec.start", userId, {}, now),
    });
    return null;
  }

  // WS `rec.stop` (starter only): flip state inactive immediately (indicator drops for everyone) and
  // append `rec.stop`; the ROW finalizes later via the REST `complete` (App-A). Clearing the pointer
  // is the graceful signal that a subsequent voice-leave must NOT treat as a dirty-end.
  async stop(userId: string, now: number): Promise<ErrorCode | null> {
    const control = await this.readControl();
    if (control === null || control.startedBy !== userId) return "forbidden";
    await this.setControl(null);
    this.room.broadcast({ t: "rec.state", recording: { active: false }, at: now });
    this.room.broadcast({
      t: "activity.new",
      entry: this.activity.append("rec.stop", userId, {}, now),
    });
    return null;
  }

  // Dirty end (§7.4): the starter's sockets all closed OR they left voice while still active (no prior
  // rec.stop). Abort the R2 multipart, delete the row, drop the pointer, broadcast inactive, and append
  // `rec.stop meta:{aborted:true}`. Idempotent: a no-op unless `userId` owns the active pointer, so a
  // repeated leave/alarm sweep never double-appends.
  async handleUserGone(userId: string, now: number): Promise<void> {
    const control = await this.readControl();
    if (control === null || control.startedBy !== userId) return;
    const row = this.rowById(control.recordingId);
    await this.abortMultipart(control.recordingId, row?.uploadId ?? null);
    this.sql.exec(`DELETE FROM recordings WHERE id = ?`, control.recordingId);
    await this.setControl(null);
    this.room.broadcast({ t: "rec.state", recording: { active: false }, at: now });
    this.room.broadcast({
      t: "activity.new",
      entry: this.activity.append("rec.stop", userId, { aborted: true }, now),
    });
  }

  // Internal `open` (Worker `POST /recordings`): the caller, still in voice, opens the multipart for
  // their own in-flight recording — authorized on the ROW (started_by + not-yet-finalized), not the KV
  // control pointer, because the sink opens lazily on the FIRST part, which for a short recording is
  // the final part that arrives just AFTER `rec.stop` clears the pointer (§7.4). Idempotent: a row that
  // already holds an upload id returns it rather than orphaning a second multipart.
  async openMultipart(userId: string): Promise<OpenResult> {
    const row = this.inflightRowFor(userId);
    if (row === null) return { ok: false, error: "forbidden" };
    if (!(await this.isInVoice(userId))) return { ok: false, error: "not_in_voice" };
    if (row.uploadId !== null) return { ok: true, recordingId: row.id, uploadId: row.uploadId };
    // Stamp the WebM content-type on the object so `GET /api/media/*` serves it typed (browsers refuse
    // to decode audio served without a media type). The recorder's MIME is audio/webm;codecs=opus.
    const upload = await this.media.createMultipartUpload(this.r2Key(row.id), {
      httpMetadata: { contentType: "audio/webm" },
    });
    this.sql.exec(`UPDATE recordings SET upload_id = ? WHERE id = ?`, upload.uploadId, row.id);
    return { ok: true, recordingId: row.id, uploadId: upload.uploadId };
  }

  // The caller's single in-flight (unfinalized) recording row, newest first.
  private inflightRowFor(userId: string): { id: string; uploadId: string | null } | null {
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT id, upload_id FROM recordings WHERE started_by = ? AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1`,
        userId,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: String(row["id"]),
      uploadId: row["upload_id"] === null ? null : String(row["upload_id"]),
    };
  }

  // Internal `resolve` (backs the PUT part + POST complete routes): the caller must own the row and it
  // must still be in-flight (upload_id set). Returns the upload id + key + start time (for the route's
  // size / duration guards). Not keyed on the active pointer — the FINAL part arrives after rec.stop.
  resolve(userId: string, recordingId: string): ResolveResult {
    const row = this.rowById(recordingId);
    if (row === null) return { ok: false, error: "not_found" };
    if (row.startedBy !== userId) return { ok: false, error: "forbidden" };
    if (row.uploadId === null) return { ok: false, error: "not_found" };
    return {
      ok: true,
      uploadId: row.uploadId,
      r2Key: this.r2Key(recordingId),
      startedAt: row.startedAt,
    };
  }

  // Internal `finalize` (from the Worker `complete`): stamp ended_at + the capped duration, clear the
  // in-flight upload id. The row now surfaces in the list (§ list() filters on ended_at). Re-broadcasts
  // `rec.state` (unchanged inactive) as the "recordings list changed" nudge so every client's
  // Recordings tab refetches AFTER the row is finalized (App-A has no dedicated rec.updated frame).
  finalize(recordingId: string, durationMs: number): MutateResult {
    const row = this.rowById(recordingId);
    if (row === null) return { ok: false, error: "not_found" };
    const capped = Math.min(durationMs, LIMITS.recordingMaxDurationMs);
    this.sql.exec(
      `UPDATE recordings SET ended_at = ?, duration_ms = ?, upload_id = NULL WHERE id = ?`,
      Date.now(),
      capped,
      recordingId,
    );
    this.room.broadcast({ t: "rec.state", recording: this.state(), at: Date.now() });
    return { ok: true };
  }

  // Internal `abort` (Worker `POST .../abort`): starter aborts an in-flight upload — same cancel path
  // as a dirty end (R2 abort + row delete + pointer clear + inactive broadcast + aborted activity).
  async abort(userId: string, recordingId: string, now: number): Promise<MutateResult> {
    const row = this.rowById(recordingId);
    if (row === null) return { ok: false, error: "not_found" };
    if (row.startedBy !== userId) return { ok: false, error: "forbidden" };
    await this.abortMultipart(recordingId, row.uploadId);
    this.sql.exec(`DELETE FROM recordings WHERE id = ?`, recordingId);
    const control = await this.readControl();
    if (control?.recordingId === recordingId) {
      await this.setControl(null);
      this.room.broadcast({ t: "rec.state", recording: { active: false }, at: now });
      this.room.broadcast({
        t: "activity.new",
        entry: this.activity.append("rec.stop", userId, { aborted: true }, now),
      });
    }
    return { ok: true };
  }

  // Internal `delete` (Worker DELETE): starter or admin removes a finalized recording. Returns the R2
  // key so the route deletes the object; the row is removed here.
  remove(userId: string, isAdmin: boolean, recordingId: string): DeleteResult {
    const row = this.rowById(recordingId);
    if (row === null) return { ok: false, error: "not_found" };
    if (row.startedBy !== userId && !isAdmin) return { ok: false, error: "forbidden" };
    this.sql.exec(`DELETE FROM recordings WHERE id = ?`, recordingId);
    // The same typed nudge used after finalization keeps peer recording lists and Tavern Home in sync.
    this.room.broadcast({ t: "rec.state", recording: this.state(), at: Date.now() });
    return { ok: true, r2Key: this.r2Key(recordingId) };
  }

  // Internal list (Worker GET): finalized recordings, newest first (§7.6 Recordings tab). In-flight /
  // aborted rows (ended_at NULL) are not playable, so they are excluded.
  list(offset = 0, limit?: number): { recordings: Recording[]; hasMore: boolean } {
    const take = Math.min(Math.max(1, limit ?? LIMITS.historyPageSize), LIMITS.historyPageSize);
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT id, started_by, duration_ms, started_at, ended_at FROM recordings
         WHERE ended_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
        take + 1,
        offset,
      )
      .toArray()
      .map((row) => ({
        id: String(row["id"]),
        startedBy: String(row["started_by"]),
        durationMs: row["duration_ms"] === null ? null : Number(row["duration_ms"]),
        startedAt: Number(row["started_at"]),
        endedAt: row["ended_at"] === null ? null : Number(row["ended_at"]),
      }));
    return { recordings: rows.slice(0, take), hasMore: rows.length > take };
  }

  private async abortMultipart(recordingId: string, uploadId: string | null): Promise<void> {
    if (uploadId === null) return;
    // resumeMultipartUpload().abort() throws if the upload was already completed/aborted — tolerate it
    // so a dirty end after a part failure still deletes the row and broadcasts.
    try {
      await this.media.resumeMultipartUpload(this.r2Key(recordingId), uploadId).abort();
    } catch {
      // Already gone on R2's side — nothing to clean up.
    }
  }

  private rowById(
    recordingId: string,
  ): { startedBy: string; uploadId: string | null; startedAt: number } | null {
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT started_by, upload_id, started_at FROM recordings WHERE id = ? LIMIT 1`,
        recordingId,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return {
      startedBy: String(row["started_by"]),
      uploadId: row["upload_id"] === null ? null : String(row["upload_id"]),
      startedAt: Number(row["started_at"]),
    };
  }
}
