import { DEFAULT_POINT_CONFIG } from "@tavern/shared";
import type { Member, Presence } from "@tavern/shared";

// ServerRoom DO SQLite schema (PLAN §5.2) + the member-profile cache table (the DO resolves
// usernames/colors/mentions without D1 access; profiles are pushed via the Worker internal routes).
// Every statement is CREATE TABLE IF NOT EXISTS so `migrate` is idempotent on every DO construction.
// SqlStorage.exec runs one statement per call, so each table is its own exec.
export function migrate(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS members(user_id TEXT PRIMARY KEY, username TEXT NOT NULL,
       display_name TEXT NOT NULL, color TEXT NOT NULL, avatar_key TEXT,
       is_admin INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,
       channel_id TEXT NOT NULL DEFAULT 'main',
       user_id TEXT NOT NULL, body TEXT NOT NULL,
       mentions TEXT NOT NULL DEFAULT '[]',
       created_at INTEGER NOT NULL)`,
  );
  // Additive GIF-attachment column (nullable JSON of the shared `GifAttachment`). ALTER is not
  // idempotent, so this runs only when the column is missing — brand-new DOs get it right after the
  // CREATE above; DOs that predate this migration (production) get it on their next construction.
  addColumnIfMissing(sql, "messages", "gif", "TEXT");
  // Additive image-attachment column (nullable JSON of the shared `ImageAttachment`) — same additive
  // migration shape as `gif`: NULL for text/gif-only rows and every row that predates this column.
  addColumnIfMissing(sql, "messages", "image", "TEXT");
  addColumnIfMissing(sql, "messages", "reply_to_id", "INTEGER");
  addColumnIfMissing(sql, "messages", "edited_at", "INTEGER");
  addColumnIfMissing(sql, "messages", "deleted_at", "INTEGER");
  sql.exec(
    `CREATE TABLE IF NOT EXISTS message_reactions(
       message_id INTEGER NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL,
       display_name TEXT NOT NULL, created_at INTEGER NOT NULL,
       PRIMARY KEY(message_id, user_id, emoji))`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS message_reactions_message_idx
       ON message_reactions(message_id, created_at, user_id)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS message_reads(user_id TEXT PRIMARY KEY,
       last_read_id INTEGER NOT NULL DEFAULT 0)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS chat_image_cleanup(image_id TEXT PRIMARY KEY,
       message_id INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT,
       type TEXT NOT NULL,
       user_id TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS sounds(id TEXT PRIMARY KEY, name TEXT NOT NULL, uploader_id TEXT NOT NULL,
       r2_key TEXT NOT NULL, duration_ms INTEGER NOT NULL,
       trim_start_ms INTEGER NOT NULL DEFAULT 0, trim_end_ms INTEGER NOT NULL,
       created_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS sound_plays(id INTEGER PRIMARY KEY AUTOINCREMENT, sound_id TEXT NOT NULL,
       user_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY, started_by TEXT NOT NULL, r2_key TEXT NOT NULL,
       upload_id TEXT,
       duration_ms INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS screenshots(id TEXT PRIMARY KEY, captured_by TEXT NOT NULL,
       r2_key TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS voice_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,
       channel_id TEXT NOT NULL DEFAULT 'main',
       started_at INTEGER NOT NULL, ended_at INTEGER)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS hangouts(id INTEGER PRIMARY KEY AUTOINCREMENT,
       started_at INTEGER NOT NULL, pending_ended_at INTEGER, ended_at INTEGER,
       shared_duration_ms INTEGER NOT NULL DEFAULT 0)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS hangout_intervals(id INTEGER PRIMARY KEY AUTOINCREMENT,
       hangout_id INTEGER NOT NULL, user_id TEXT NOT NULL,
       joined_at INTEGER NOT NULL, left_at INTEGER)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS hangout_intervals_hangout_idx
       ON hangout_intervals(hangout_id, joined_at)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS home_migrations(key TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS stat_stream_seconds(user_id TEXT PRIMARY KEY, seconds INTEGER NOT NULL DEFAULT 0)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS stat_watch_seconds(viewer_id TEXT NOT NULL, streamer_id TEXT NOT NULL,
       seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (viewer_id, streamer_id))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS egress_log(month TEXT PRIMARY KEY,
       bytes INTEGER NOT NULL DEFAULT 0)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS point_config(
       id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL,
       base_points_per_minute INTEGER NOT NULL, streamer_bonus_per_minute INTEGER NOT NULL,
       watcher_bonus_per_minute INTEGER NOT NULL, daily_cap INTEGER,
       updated_at INTEGER NOT NULL, updated_by TEXT)`,
  );
  sql.exec(
    `INSERT OR IGNORE INTO point_config(
       id, enabled, base_points_per_minute, streamer_bonus_per_minute,
       watcher_bonus_per_minute, daily_cap, updated_at, updated_by)
     VALUES (1, ?, ?, ?, ?, ?, 0, NULL)`,
    DEFAULT_POINT_CONFIG.enabled ? 1 : 0,
    DEFAULT_POINT_CONFIG.basePointsPerMinute,
    DEFAULT_POINT_CONFIG.streamerBonusPerMinute,
    DEFAULT_POINT_CONFIG.watcherBonusPerMinute,
    DEFAULT_POINT_CONFIG.dailyCap,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS point_accounts(
       user_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS point_sources(
       user_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('conversation','streaming','watching')),
       active INTEGER NOT NULL DEFAULT 0, started_at INTEGER, remainder INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY(user_id, source))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS point_daily(
       user_id TEXT NOT NULL, day TEXT NOT NULL,
       conversation INTEGER NOT NULL DEFAULT 0, streaming INTEGER NOT NULL DEFAULT 0,
       watching INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS polls(
       id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, creator_display_name TEXT NOT NULL,
       question TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN
         ('open','locked','resolved_pending','finalized','voided')),
       created_at INTEGER NOT NULL, closes_at INTEGER NOT NULL, locked_at INTEGER,
       resolved_at INTEGER, finalizes_at INTEGER, finalized_at INTEGER, voided_at INTEGER,
       winning_outcome_id TEXT, correction_used INTEGER NOT NULL DEFAULT 0,
       result_visible_until INTEGER)`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS polls_created_idx ON polls(created_at DESC)`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS polls_due_idx ON polls(status, closes_at, locked_at, finalizes_at)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS poll_outcomes(
       id TEXT PRIMARY KEY, poll_id TEXT NOT NULL, title TEXT NOT NULL, position INTEGER NOT NULL,
       UNIQUE(poll_id, position))`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS poll_outcomes_poll_idx ON poll_outcomes(poll_id, position)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS poll_bids(
       poll_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL,
       outcome_id TEXT NOT NULL, stake INTEGER NOT NULL CHECK(stake > 0),
       payout INTEGER NOT NULL DEFAULT 0, placed_at INTEGER NOT NULL,
       PRIMARY KEY(poll_id, user_id))`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS poll_bids_poll_idx ON poll_bids(poll_id, outcome_id)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS poll_events(
       id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id TEXT NOT NULL, actor_id TEXT,
       action TEXT NOT NULL, from_outcome_id TEXT, to_outcome_id TEXT, at INTEGER NOT NULL)`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS poll_events_poll_idx ON poll_events(poll_id, id)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS point_transactions(
       tx_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, poll_id TEXT NOT NULL,
       kind TEXT NOT NULL CHECK(kind IN ('poll_stake','poll_refund','poll_payout')),
       delta INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  );
}

// Idempotent single-column `ALTER TABLE … ADD COLUMN`: a no-op when the column already exists (SQLite
// has no `ADD COLUMN IF NOT EXISTS`, and a blind ALTER throws on re-run). `table`/`column`/`type` are
// module-internal string constants (never user input), so the interpolation carries no injection risk.
function addColumnIfMissing(sql: SqlStorage, table: string, column: string, type: string): void {
  const columns = sql
    .exec<Record<string, SqlStorageValue>>(`PRAGMA table_info(${table})`)
    .toArray();
  if (columns.some((c) => c["name"] === column)) return;
  sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Typed row-mapper for the `members` cache table → the shared `Member` wire type. Presence is not a
// stored column (it is derived from live sockets), so it is passed in by the caller. avatar_key is
// omitted when NULL to satisfy exactOptionalPropertyTypes on the optional `avatarKey`.
export function rowToMember(row: Record<string, SqlStorageValue>, presence: Presence): Member {
  const avatarKey = row["avatar_key"];
  return {
    userId: String(row["user_id"]),
    username: String(row["username"]),
    displayName: String(row["display_name"]),
    color: String(row["color"]),
    ...(avatarKey === null || avatarKey === undefined ? {} : { avatarKey: String(avatarKey) }),
    presence,
    isAdmin: row["is_admin"] === 1,
    joinedAt: Number(row["joined_at"]),
  };
}
