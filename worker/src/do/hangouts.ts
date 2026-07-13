import { HangoutSummary, LIMITS } from "@tavern/shared";

type SqlRow = Record<string, SqlStorageValue>;

interface ActiveHangout {
  id: number;
  startedAt: number;
  pendingEndedAt: number | null;
}

// Durable projection of real multi-person voice overlap. The existing voice_sessions table answers
// a different question (first join → empty room); this module intentionally starts only when a second
// member arrives, so an idle member cannot glue unrelated conversations into one all-day session.
export class HangoutsModule {
  constructor(private readonly sql: SqlStorage) {}

  // Rebuild once from the existing authoritative voice activity log. Clearing the projection before
  // replay makes a construction interrupted before the marker fully idempotent on the next attempt.
  backfill(now: number): void {
    const done = this.sql
      .exec<SqlRow>(`SELECT completed_at FROM home_migrations WHERE key = 'hangouts-v1' LIMIT 1`)
      .toArray()[0];
    if (done !== undefined) return;

    this.sql.exec(`DELETE FROM hangout_intervals`);
    this.sql.exec(`DELETE FROM hangouts`);
    const present = new Set<string>();
    const rows = this.sql
      .exec<SqlRow>(
        `SELECT type, user_id, created_at FROM activity
         WHERE type IN ('voice.join', 'voice.leave') ORDER BY created_at ASC, id ASC`,
      )
      .toArray();
    for (const row of rows) {
      const before = [...present];
      const userId = String(row["user_id"]);
      if (String(row["type"]) === "voice.join") present.add(userId);
      else present.delete(userId);
      this.noteVoiceChange(before, [...present], Number(row["created_at"]));
    }
    this.finalizeDue(now);
    this.sql.exec(`INSERT INTO home_migrations(key, completed_at) VALUES ('hangouts-v1', ?)`, now);
  }

  // Called only after an actual voice-state mutation. Returns true when an expired prior hangout was
  // finalized while opening a new one, so the caller can publish one home invalidation.
  noteVoiceChange(beforeIds: string[], afterIds: string[], at: number): boolean {
    const before = new Set(beforeIds);
    const after = new Set(afterIds);
    if (before.size < 2 && after.size >= 2) return this.openSharedPresence([...after], at);

    const active = this.active();
    if (active === null || active.pendingEndedAt !== null) return false;

    if (before.size >= 2 && after.size >= 2) {
      for (const userId of before) {
        if (!after.has(userId)) this.closeInterval(active.id, userId, at);
      }
      for (const userId of after) {
        if (!before.has(userId)) this.openInterval(active.id, userId, at);
      }
      return false;
    }

    if (before.size >= 2 && after.size < 2) {
      this.closeAllIntervals(active.id, at);
      this.sql.exec(`UPDATE hangouts SET pending_ended_at = ? WHERE id = ?`, at, active.id);
    }
    return false;
  }

  pendingDeadline(): number | null {
    const active = this.active();
    return active?.pendingEndedAt === null || active === null
      ? null
      : active.pendingEndedAt + LIMITS.hangoutReconnectGraceMs;
  }

  // DO alarms are at-least-once, so finalization is guarded by ended_at IS NULL and is idempotent.
  // Returns true only when a qualifying hangout became visible on Tavern Home.
  finalizeDue(now: number): boolean {
    const active = this.active();
    if (
      active === null ||
      active.pendingEndedAt === null ||
      active.pendingEndedAt + LIMITS.hangoutReconnectGraceMs > now
    ) {
      return false;
    }
    return this.finalize(active);
  }

  recent(limit: number = LIMITS.homeHangoutLimit): HangoutSummary[] {
    return this.sql
      .exec<SqlRow>(
        `SELECT id, started_at, ended_at, shared_duration_ms FROM hangouts
         WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row) => this.summary(row));
  }

  private openSharedPresence(userIds: string[], at: number): boolean {
    let finalized = false;
    let active = this.active();
    if (active !== null && active.pendingEndedAt !== null) {
      if (at - active.pendingEndedAt <= LIMITS.hangoutReconnectGraceMs) {
        this.sql.exec(`UPDATE hangouts SET pending_ended_at = NULL WHERE id = ?`, active.id);
        active = { ...active, pendingEndedAt: null };
      } else {
        finalized = this.finalize(active);
        active = null;
      }
    }
    if (active === null) {
      const row = this.sql
        .exec<SqlRow>(
          `INSERT INTO hangouts(started_at, pending_ended_at, ended_at)
           VALUES (?, NULL, NULL) RETURNING id`,
          at,
        )
        .one();
      active = { id: Number(row["id"]), startedAt: at, pendingEndedAt: null };
    }
    for (const userId of userIds) this.openInterval(active.id, userId, at);
    return finalized;
  }

  private finalize(active: ActiveHangout): boolean {
    const endedAt = active.pendingEndedAt;
    if (endedAt === null) return false;
    const intervals = this.intervals(active.id);
    const totals = new Map<string, number>();
    for (const interval of intervals) {
      const duration = Math.max(0, interval.leftAt - interval.joinedAt);
      totals.set(interval.userId, (totals.get(interval.userId) ?? 0) + duration);
    }
    const participantIds = [...totals.entries()]
      .filter(([, duration]) => duration >= LIMITS.hangoutMinOverlapMs)
      .map(([userId]) => userId)
      .toSorted();
    if (participantIds.length < 2) {
      this.sql.exec(`DELETE FROM hangout_intervals WHERE hangout_id = ?`, active.id);
      this.sql.exec(`DELETE FROM hangouts WHERE id = ?`, active.id);
      return false;
    }
    const sharedDurationMs = unionDuration(intervals);
    this.sql.exec(
      `UPDATE hangouts SET ended_at = ?, shared_duration_ms = ? WHERE id = ? AND ended_at IS NULL`,
      endedAt,
      sharedDurationMs,
      active.id,
    );
    return true;
  }

  private active(): ActiveHangout | null {
    const row = this.sql
      .exec<SqlRow>(
        `SELECT id, started_at, pending_ended_at FROM hangouts
         WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .toArray()[0];
    if (row === undefined) return null;
    return {
      id: Number(row["id"]),
      startedAt: Number(row["started_at"]),
      pendingEndedAt: row["pending_ended_at"] === null ? null : Number(row["pending_ended_at"]),
    };
  }

  private openInterval(hangoutId: number, userId: string, at: number): void {
    const existing = this.sql
      .exec<SqlRow>(
        `SELECT id FROM hangout_intervals
         WHERE hangout_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1`,
        hangoutId,
        userId,
      )
      .toArray()[0];
    if (existing !== undefined) return;
    this.sql.exec(
      `INSERT INTO hangout_intervals(hangout_id, user_id, joined_at, left_at)
       VALUES (?, ?, ?, NULL)`,
      hangoutId,
      userId,
      at,
    );
  }

  private closeInterval(hangoutId: number, userId: string, at: number): void {
    this.sql.exec(
      `UPDATE hangout_intervals SET left_at = ?
       WHERE hangout_id = ? AND user_id = ? AND left_at IS NULL`,
      at,
      hangoutId,
      userId,
    );
  }

  private closeAllIntervals(hangoutId: number, at: number): void {
    this.sql.exec(
      `UPDATE hangout_intervals SET left_at = ? WHERE hangout_id = ? AND left_at IS NULL`,
      at,
      hangoutId,
    );
  }

  private intervals(hangoutId: number): PresenceInterval[] {
    return this.sql
      .exec<SqlRow>(
        `SELECT user_id, joined_at, left_at FROM hangout_intervals
         WHERE hangout_id = ? AND left_at IS NOT NULL ORDER BY joined_at ASC`,
        hangoutId,
      )
      .toArray()
      .map((row) => ({
        userId: String(row["user_id"]),
        joinedAt: Number(row["joined_at"]),
        leftAt: Number(row["left_at"]),
      }));
  }

  private summary(row: SqlRow): HangoutSummary {
    const id = Number(row["id"]);
    const totals = new Map<string, number>();
    for (const interval of this.intervals(id)) {
      totals.set(
        interval.userId,
        (totals.get(interval.userId) ?? 0) + Math.max(0, interval.leftAt - interval.joinedAt),
      );
    }
    return HangoutSummary.parse({
      id,
      participantIds: [...totals.entries()]
        .filter(([, duration]) => duration >= LIMITS.hangoutMinOverlapMs)
        .map(([userId]) => userId)
        .toSorted(),
      startedAt: Number(row["started_at"]),
      endedAt: Number(row["ended_at"]),
      sharedDurationMs: Number(row["shared_duration_ms"]),
    });
  }
}

interface PresenceInterval {
  userId: string;
  joinedAt: number;
  leftAt: number;
}

function unionDuration(intervals: PresenceInterval[]): number {
  const ranges = intervals
    .map((interval) => ({ start: interval.joinedAt, end: interval.leftAt }))
    .toSorted((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let start: number | null = null;
  let end = 0;
  for (const range of ranges) {
    if (start === null) {
      start = range.start;
      end = range.end;
    } else if (range.start <= end) {
      end = Math.max(end, range.end);
    } else {
      total += Math.max(0, end - start);
      start = range.start;
      end = range.end;
    }
  }
  return start === null ? 0 : total + Math.max(0, end - start);
}
