-- Migration 0002: servers, memberships, channels — the global server catalog (PLAN §5.1;
-- FR-08 create, FR-09 join, FR-13 channels schema). DDL is §5.1 VERBATIM: the `REFERENCES`
-- clauses are KEPT as written (documentation only — D1 does not enforce foreign keys by default,
-- and SQLite does not require the referenced table to exist at CREATE TABLE time). ONE intentional
-- deviation from §5.1's text: the `password_hash` comment there ("scrypt via better-auth's hasher")
-- is STALE — server passwords use WebCrypto PBKDF2 (worker/src/lib/passwords.ts), NOT better-auth's
-- hasher (which hashes only *user* passwords). The corrected comment is written below.
CREATE TABLE servers(
  id TEXT PRIMARY KEY,                   -- crypto.randomUUID()
  nickname TEXT NOT NULL COLLATE NOCASE UNIQUE,   -- 3..32 chars, rules §App-B
  password_hash TEXT,                    -- NULL = open server; PBKDF2-SHA256, see worker/src/lib/passwords.ts
  admin_user_id TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL            -- epoch ms (all timestamps in the app)
);
CREATE TABLE memberships(
  user_id TEXT NOT NULL REFERENCES user(id),
  server_id TEXT NOT NULL REFERENCES servers(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_id)
);
CREATE TABLE channels(                    -- FR-13: schema ready, UI fixed to the 2 defaults
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  kind TEXT NOT NULL CHECK (kind IN ('voice','text')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
