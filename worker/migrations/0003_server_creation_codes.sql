-- Migration 0003: one-time server-creation codes (FR-08 hardening). Creating a server now requires
-- a code an operator seeds BY HAND (INSERT INTO server_creation_codes(code, created_at) VALUES
-- ('<code>', <epoch ms>); via `wrangler d1 execute`) — this gates uncontrolled resource creation.
-- A code is single-use: POST /api/servers claims it atomically (UPDATE ... WHERE used_at IS NULL)
-- and records who used it, when, and which server it created.
-- NO `REFERENCES` clauses here (unlike 0002): D1 enforces foreign keys, and the route claims the
-- code — stamping created_server_id — BEFORE the servers row is inserted (so a lost claim race never
-- creates an unpaid-for server). An FK on created_server_id would reject that ordering.
CREATE TABLE server_creation_codes(
  code TEXT PRIMARY KEY,      -- the literal code the operator hands out
  created_at INTEGER NOT NULL, -- epoch ms (all timestamps in the app)
  used_by_user_id TEXT,        -- user(id); NULL until used
  used_at INTEGER,             -- NULL until used; non-NULL = burned
  created_server_id TEXT       -- servers(id); the server the code created
);
