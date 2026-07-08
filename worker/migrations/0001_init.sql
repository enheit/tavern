-- Migration 0001 — initial D1 schema (PLAN §1 "D1 schema (migration 0001, exact)").
-- The ServerRoom DO's own SQLite tables (messages, presence) are created in the DO
-- constructor at S2.4, NOT here — this migration is the D1 (control-plane) schema only.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL COLLATE NOCASE UNIQUE,
  nickname_color TEXT NOT NULL DEFAULT '#8a8f98',
  avatar_key TEXT,
  pw_hash BLOB NOT NULL, pw_salt BLOB NOT NULL,
  pw_iterations INTEGER NOT NULL DEFAULT 100000,
  pw_algo TEXT NOT NULL DEFAULT 'pbkdf2-sha256',
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  pw_hash BLOB, pw_salt BLOB,
  created_at INTEGER NOT NULL
);
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','voice')),
  pw_hash BLOB, pw_salt BLOB,
  position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE(server_id, name)
);
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  server_id TEXT NOT NULL REFERENCES servers(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_id)
);
CREATE TABLE channel_access (
  user_id TEXT NOT NULL, channel_id TEXT NOT NULL, granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE budget_usage (
  month TEXT NOT NULL, server_id TEXT NOT NULL,
  est_gb REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (month, server_id)
);
