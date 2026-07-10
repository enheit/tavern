# S1.1 — Worker bootstrap (Hono + bindings + vitest-pool-workers)

- after: S0.3
- unlocks: S1.2, S4.4
- FRs: — (infrastructure; every backend FR depends on it)
- references: PLAN §2 (A2), §3.4, §3.5, §3.6, §4, §0.2 R7

## Goal

A deployable `@tavern/worker` package: Hono app with typed Cloudflare bindings (D1, R2, ServerRoom
DO, assets), one health route, vitest-pool-workers wired, bound to the PRE-PROVISIONED resources
on Roman's personal Cloudflare account (PLAN §5.1/§5.3 — reused from the abandoned
implementation, hard-wiped 2026-07-10; this step creates NO cloud resources). No business logic.

## Preconditions (run these; red = STOP)

- `grep -q "^## S0.3" docs/progress.md` → exit 0
- `pnpm -w install --frozen-lockfile` → exit 0
- `pnpm dlx wrangler@4.110.0 whoami` → output MUST contain account id
  `fd8a5f7a38f28a2cd11e79e85985c7d4` (Roman's personal account). Any other account (especially
  anything named Icelook / `2b2a6ee3a36bb5d314e239c06461efb3`) → STOP, do not provision anything.

## Tasks (numbered, imperative, zero alternatives)

1. EXTEND the existing `worker/package.json` (S0.1 already created it with name `@tavern/worker`,
   `private: true`, `type: "module"`, `exports`, and `"typecheck": "tsc --noEmit"`). KEEP the
   `typecheck` script (later gates call `pnpm -F @tavern/worker typecheck` directly — dropping it
   breaks them) and ADD these scripts, so the final `scripts` block is exactly:

   ```json
   "scripts": {
     "typecheck": "tsc --noEmit",
     "dev": "wrangler dev",
     "deploy": "wrangler deploy",
     "test": "vitest run --coverage",
     "types": "wrangler types",
     "migrate:local": "wrangler d1 migrations apply tavern-db --local",
     "migrate:remote": "wrangler d1 migrations apply tavern-db --remote"
   }
   ```
2. Install exact deps: `pnpm --filter @tavern/worker add -E hono@4.12.28 zod@4.4.3` and
   `pnpm --filter @tavern/worker add -E @tavern/shared@workspace:*` and
   `pnpm --filter @tavern/worker add -DE wrangler@4.110.0 vitest@4.1.10 @cloudflare/vitest-pool-workers@0.18.4 @vitest/coverage-istanbul@4.1.10`.
3. Create `worker/wrangler.jsonc` with EXACTLY this content (`account_id` hard-pins Roman's
   personal account so no token/OAuth ambiguity can ever route a deploy elsewhere; the
   `database_id` is the pre-provisioned database — PLAN §5.1):

   ```jsonc
   {
     "name": "tavern",
     "account_id": "fd8a5f7a38f28a2cd11e79e85985c7d4",
     "main": "src/index.ts",
     "compatibility_date": "2026-07-09",
     "compatibility_flags": ["nodejs_compat"],
     "d1_databases": [
       {
         "binding": "DB",
         "database_name": "tavern-db",
         "database_id": "49d52212-7fd9-4d4e-a7dd-d48f90dc0219",
         "migrations_dir": "migrations"
       }
     ],
     "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "tavern-media" }],
     "durable_objects": {
       "bindings": [{ "name": "SERVER_ROOM", "class_name": "ServerRoom" }]
     },
     "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ServerRoom"] }],
     "assets": {
       "directory": "../app/dist",
       "binding": "ASSETS",
       "not_found_handling": "single-page-application",
       "run_worker_first": ["/api/*"]
     },
     "observability": { "enabled": true },
     "secrets": {
       "required": [
         "BETTER_AUTH_SECRET",
         "REALTIME_APP_ID",
         "REALTIME_APP_SECRET",
         "TURN_KEY_ID",
         "TURN_KEY_API_TOKEN"
       ]
     }
   }
   ```

   `new_sqlite_classes` is mandatory (NOT `new_classes` — §3.6 item 8).
4. Create `worker/src/index.ts`: Hono app typed `Hono<{ Bindings: Env }>`; route
   `GET /api/health` → `200 {"ok":true}`; add `app.notFound((c) => c.json({ error: 'not_found' }, 404))`
   (`'not_found'` is an `ErrorCode` from `@tavern/shared` — Hono's default notFound is plain-text,
   which would fail the 404 test below); `export default app` and `export { ServerRoom }`.
   Create `worker/src/do/ServerRoom.ts`: placeholder class extending `DurableObject` from
   `cloudflare:workers` whose `fetch()` returns `501 {"error":"not_implemented"}` (replaced in
   S3.1; needed now so the DO binding deploys).
5. Create `worker/.dev.vars.example` with the five secret keys set to dev placeholders
   (`BETTER_AUTH_SECRET=dev-secret-change-me`, others empty); add `worker/.dev.vars` to the root
   `.gitignore` (S0.1 already has the entry — verify, don't duplicate).
6. Create `worker/vitest.config.ts` using the CURRENT pool-workers style — the `cloudflareTest()`
   Vite plugin from `@cloudflare/vitest-pool-workers` (the old `defineWorkersConfig`/`poolOptions`
   shape is obsolete — §3.6 item 7). Pinned requirements the config must express (exact option
   names per the get-started doc below):
   - wrangler config path `./wrangler.jsonc`;
   - a `TEST_MIGRATIONS` binding fed by `readD1Migrations('./migrations')` (from
     `@cloudflare/vitest-pool-workers/config`);
   - `test.include: ['test/**/*.test.ts']`, `test.setupFiles: ['test/setup.ts']`;
   - coverage: provider `istanbul`, `thresholds: { lines: 80 }`, include `src/**`.
   Create `worker/test/setup.ts`: `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (from
   `cloudflare:test`). Create `worker/migrations/.gitkeep` (first real migration lands in S1.2).
   MODIFY `worker/tsconfig.json` (S0.1 created it as `{ extends, include: ["src","test"] }`) to
   exactly:

   ```json
   {
     "extends": "../tsconfig.base.json",
     "include": ["src", "test", "worker-configuration.d.ts"],
     "compilerOptions": { "types": ["@cloudflare/vitest-pool-workers"] }
   }
   ```

   Without the `worker-configuration.d.ts` include, `Env` (referenced by `src/index.ts`) is
   outside the compile globs; without the `types` entry, `test/setup.ts`'s `cloudflare:test`
   import has no module declaration. Both are TS errors that redden `pnpm -w typecheck`.
7. Verify the pre-provisioned resources + provision the first secret (account check from
   Preconditions must have passed; the D1 database and R2 bucket are REUSED — creating or
   deleting any cloud resource in this step is an R1 violation):
   - `pnpm --filter @tavern/worker exec wrangler d1 list` → contains `tavern-db` with uuid
     `49d52212-7fd9-4d4e-a7dd-d48f90dc0219` (already pinned in `wrangler.jsonc`, task 3).
   - `pnpm --filter @tavern/worker exec wrangler r2 bucket list` → contains `tavern-media`.
   - Generate the auth secret: `openssl rand -base64 32`; then
     `pnpm --filter @tavern/worker exec wrangler secret put BETTER_AUTH_SECRET` (paste it) and
     store the same value in the Bitwarden MCP under the `tavern` project folder as
     `tavern / BETTER_AUTH_SECRET` (R7). Note: no `tavern` worker exists remotely (the old one
     was deleted 2026-07-10) — wrangler will offer to create a draft Worker to hold the secret;
     accept (its non-interactive fallback is yes). The draft holds secrets until S11.1's first
     real deploy overwrites it. Pre-authorized contingency (§3.7 style — execute, record in
     progress.md, not a blocker): if `secret put` fails with API error 10007
     (workers-sdk#14258 — `secrets.required` present while the worker doesn't exist), comment
     out the `secrets` block in `wrangler.jsonc`, rerun `secret put` (the draft worker gets
     created), restore the block verbatim. Copy `.dev.vars.example` → `.dev.vars` and put a
     different local value there.
     The four Realtime/TURN secrets are provisioned in S7.1 — do NOT create them now; the
     `secrets.required` list will make `wrangler deploy` (non-dry-run) fail until S7.1, which is
     expected and documented here.
8. Run `pnpm --filter @tavern/worker types` → commit the generated `worker-configuration.d.ts`.
9. Write the test (see Tests), run DoD gates, append the §0.3 progress entry (include the real
   `database_id` and a note that deploy-blocking secrets arrive in S7.1).

## Pinned interfaces & artifacts

- Files created: `worker/wrangler.jsonc`, `worker/src/index.ts`, `worker/src/do/ServerRoom.ts`,
  `worker/vitest.config.ts`, `worker/test/setup.ts`, `worker/test/health.test.ts`,
  `worker/.dev.vars.example`, `worker/migrations/.gitkeep`,
  `worker/worker-configuration.d.ts` (generated).
- Files modified (S0.1 created them): `worker/package.json` (scripts, task 1),
  `worker/tsconfig.json` (include + `types`, task 6).
- `Env` comes ONLY from `wrangler types` output — never hand-written.
- Error envelope convention starts here: every non-2xx JSON body is `{ "error": <ErrorCode> }`
  (codes from `@tavern/shared` `errors.ts`).
- Dependents rely on: binding names `DB`, `MEDIA`, `SERVER_ROOM`, `ASSETS`; worker name `tavern`;
  route prefix `/api`; DO class name `ServerRoom`.

## Tests

- `worker/test/health.test.ts` — `describe('S1.1 worker bootstrap')`:
  - `GET /api/health returns 200 {ok:true}` (via `SELF.fetch`)
  - `unknown /api route returns 404 with {error:"not_found"}`
  - `direct ServerRoom fetch returns 501 {error:"not_implemented"}` — get a stub via
    `env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName('t'))` and `.fetch('http://do/')`; this
    exercises `src/do/ServerRoom.ts` so its body counts toward the ≥80% line-coverage gate.

## DoD gates (verbatim, from repo root)

- [ ] `mkdir -p app/dist && printf '<!doctype html><title>Tavern</title>' > app/dist/index.html`
      (local, uncommitted — wrangler requires the assets dir to exist; the real app build owns
      this path from S4.2 on) → exit 0
- [ ] `pnpm --filter @tavern/worker test` → all tests pass, coverage lines ≥80%, exit 0
- [ ] `pnpm --filter @tavern/worker exec wrangler deploy --dry-run` → exit 0
- [ ] `pnpm --filter @tavern/worker exec wrangler dev` (background) then
      `curl -s http://localhost:8787/api/health` → `{"ok":true}`; kill wrangler dev
- [ ] `pnpm -w lint && pnpm -w typecheck` → exit 0

## STOP conditions (beyond global R1)

- `wrangler whoami` shows any account other than `fd8a5f7a38f28a2cd11e79e85985c7d4`.
- `wrangler d1 list` lacks `tavern-db` with the pinned uuid, or `wrangler r2 bucket list` lacks
  `tavern-media` — the pre-provisioned resources are missing; do NOT create replacements.
- The `cloudflareTest()` plugin or `secrets.required` key is rejected by the pinned
  wrangler/pool-workers versions (doc drift) — blocker, do not downgrade/upgrade.

## Docs (consult only these)

- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://hono.dev/docs/getting-started/cloudflare-workers
