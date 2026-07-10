-- Migration 0001: user_settings (cross-device profile settings, PLAN §5.1 / FR-06, FR-07, FR-16).
-- DDL is §5.1 verbatim EXCEPT the `REFERENCES user(id)` clause on user_id is intentionally OMITTED
-- (pinned S1.3 task 1: cross-step independence — user_settings must migrate without the auth `user`
-- table's presence ordering; D1 does not enforce foreign keys by default anyway, so the reference is
-- documentation-only and its removal changes no runtime behaviour). Booleans are SQLite INTEGER 0/1.
CREATE TABLE user_settings(
  user_id TEXT PRIMARY KEY,
  notify_all INTEGER NOT NULL DEFAULT 1,
  notify_mentions INTEGER NOT NULL DEFAULT 1,
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','uk')),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system'))
);
