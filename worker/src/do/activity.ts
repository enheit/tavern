import { ActivityEntry, LIMITS } from "@tavern/shared";
import type { ActivityType } from "@tavern/shared";

// Owns the `activity` table (§5.2, S3.1's migration — no schema change): a persisted per-server log
// with an append API for every event producer and a paginated read for the Activity tab. The
// ServerRoom DO calls `append` from each producer and broadcasts `activity.new{entry}`; `page` backs
// the HTTP read (`GET /internal/activity` → §6.1 `GET /api/servers/:id/activity`).
//
// `type` is the App-A closed enum (`ActivityType`) — the compile-time signature is the contract, so a
// producer passing a type outside the enum does not compile (S3.3 STOP condition); `ActivityEntry.parse`
// re-checks it on read (§9.8 / A9: SQL read-back is a trust boundary).
export class ActivityModule {
  constructor(private readonly sql: SqlStorage) {}

  // Inserts one row and returns the persisted entry. `meta` defaults to `{}` (member.join/kick carry
  // none); `now` is passed in (server clock) so callers stay testable, mirroring ChatModule.send.
  append(
    type: ActivityType,
    userId: string,
    meta: Record<string, string> = {},
    now: number = Date.now(),
  ): ActivityEntry {
    const row = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `INSERT INTO activity (type, user_id, meta, created_at)
         VALUES (?, ?, ?, ?) RETURNING id`,
        type,
        userId,
        JSON.stringify(meta),
        now,
      )
      .one();
    return { id: Number(row["id"]), type, userId, meta, at: now };
  }

  // Newest-first window of `min(limit, historyPageSize)` rows, returned oldest→newest within the page
  // (mirrors ChatModule.history exactly, §S3.3 task 3). `hasMore` is true when a further (older) row
  // exists beyond the window — detected by fetching one extra row rather than a second COUNT query.
  page(input: { before?: number; limit: number }): {
    entries: ActivityEntry[];
    hasMore: boolean;
  } {
    const limit = Math.min(input.limit, LIMITS.historyPageSize);
    const window = limit + 1;
    const rows =
      input.before === undefined
        ? this.sql
            .exec<Record<string, SqlStorageValue>>(
              `SELECT id, type, user_id, meta, created_at FROM activity
               ORDER BY id DESC LIMIT ?`,
              window,
            )
            .toArray()
        : this.sql
            .exec<Record<string, SqlStorageValue>>(
              `SELECT id, type, user_id, meta, created_at FROM activity
               WHERE id < ? ORDER BY id DESC LIMIT ?`,
              input.before,
              window,
            )
            .toArray();
    const hasMore = rows.length > limit;
    // Query is newest-first (id DESC); reverse to oldest→newest within the page. `toReversed` returns a
    // fresh array (the mapped array is already a copy, but the linter forbids the mutating `reverse`).
    const entries = rows.slice(0, limit).map(rowToActivityEntry).toReversed();
    return { entries, hasMore };
  }
}

// Typed `activity` row → the shared `ActivityEntry` wire type; `ActivityEntry.parse` validates the
// read-back (the meta JSON + the type against the App-A enum) so downstream frames are contract-valid.
function rowToActivityEntry(row: Record<string, SqlStorageValue>): ActivityEntry {
  const meta: unknown = JSON.parse(String(row["meta"]));
  return ActivityEntry.parse({
    id: Number(row["id"]),
    type: String(row["type"]),
    userId: String(row["user_id"]),
    meta,
    at: Number(row["created_at"]),
  });
}
