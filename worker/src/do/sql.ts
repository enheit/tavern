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
    `CREATE TABLE IF NOT EXISTS voice_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,
       channel_id TEXT NOT NULL DEFAULT 'main',
       started_at INTEGER NOT NULL, ended_at INTEGER)`,
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
