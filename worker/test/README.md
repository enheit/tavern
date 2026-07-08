# Worker tests

Vitest + `@cloudflare/vitest-pool-workers` running in **workerd**. The project is
configured (see `../vitest.config.ts`) with `singleWorker: true` and
`isolatedStorage: false` — required so WebSocket and Durable Object tests work
(per-file storage isolation is unsupported for those). PLAN §1.

Consequence: **storage (D1 + DO SQLite) is shared across the whole run.**

## Random-fixture rule (MANDATORY)

Every test MUST create its own users / servers / channels using
`crypto.randomUUID()`-derived names, and MUST NOT:

- assert on global table counts (e.g. `SELECT COUNT(*) FROM users`), or
- rely on a clean/empty database, or
- reuse a fixed nickname/server-id another test might also use.

This keeps tests independent despite the shared storage. A test that needs
"a user" makes `user_${crypto.randomUUID()}`, not `"bob"`.

## Coverage

Provider is **istanbul** (V8 coverage is unavailable in workerd). Run with
`pnpm --filter tavern-worker test:cov`. The ≥85% worker-lines gate is measured
now and enforced starting S2.1.
