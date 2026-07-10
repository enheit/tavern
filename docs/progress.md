# Progress log

> One entry per completed step, appended by the implementing agent, committed with the step.
> Template: PLAN.md §0.3. A step without a green entry here does not exist.

## S0.1 — Repo bootstrap — 2026-07-10
- Agent: claude-opus-4-8[1m] (orchestrator, inline — bootstrap needs integrator judgment on stray files)
- DoD results:
  - `pnpm install` → exit 0, `pnpm-lock.yaml` created (pnpm 11.10.0 via corepack; oxc-parser 0.139.0, oxfmt 0.58.0, oxlint 1.73.0, typescript 7.0.2)
  - `pnpm lint` → exit 0
  - `pnpm format:check` → exit 0 ("All matched files use the correct format", 6 files)
  - `pnpm typecheck` → exit 0 (all five packages green)
  - `git status --porcelain` after commit → empty
- Files created/modified: pnpm-workspace.yaml, package.json, tsconfig.base.json, .oxlintrc.json,
  .oxfmtrc.json, .gitignore, README.md; {shared,worker,app,desktop,e2e}/{package.json,tsconfig.json,src/index.ts};
  also committed pre-existing repo assets (CLAUDE.md, .mcp.json, docs/, images/, task.md).
- Deviations (2 — real plan-vs-pinned-toolchain conflicts, resolved intent-preservingly; flagged to human):
  1. Placeholder `src/index.ts` content: spec pins *exactly* `export {};`, but oxlint 1.73.0's
     unicorn `require-module-specifiers` (correctness=error) rejects empty export specifiers.
     Changed to `export const placeholder = true;` (same purpose — a strict-mode module giving
     lint/typecheck input; every later step overwrites these files).
  2. `.oxfmtrc.json` ignorePatterns `[]` → `["**/*.md","**/*.json","**/*.jsonc"]`. §3.1 states
     oxfmt "Covers JS/TS/JSX/TSX — other file types stay unformatted", but oxfmt 0.58.0 also
     formats MD/JSON, so the plan's own committed docs (PLAN.md, step files) + pinned verbatim
     JSON configs failed `format:check`. Restricting oxfmt to code matches §3.1's stated intent
     and keeps pinned config/docs verbatim.
- Notes for dependents: pnpm is 11.10.0 (corepack). oxfmt gate is code-only (TS/JS/JSX/TSX) — do
  not rely on it to format JSON/MD. Placeholder export idiom is `export const placeholder = true;`.

## S0.2 — @tavern/shared contract package — 2026-07-10
- Agent: claude-opus-4-8[1m] (orchestrator, inline — background agent stalled twice on this step; foundation is sequential so no parallelism lost)
- DoD results:
  - `pnpm -F @tavern/shared test:coverage` → exit 0; 5 files / 16 tests passed; coverage Lines 100% (130/130), Branches 100% (16/16), Funcs 100% (9/9) — ≥90% gate met
  - `pnpm typecheck && pnpm lint && pnpm format:check` → exit 0
  - `node -e "...dependencies zod-only..."` → exit 0 (zod is the only runtime dep)
  - `grep -c "describe('FR-32" shared/test/layout.test.ts` → 1
- Files created: shared/src/{limits,errors,domain,presets,layout,protocol,api,ipc}.ts, shared/src/index.ts (barrel),
  shared/vitest.config.ts, shared/test/{layout,limits,presets,protocol,contract}.test.ts; shared/package.json (deps+scripts)
- Deviations (minor, non-contract):
  1. `presets.ts` exports `PRESET_IDS` (`as const` data) and derives `PresetId` from it, instead of spelling the
     literal-union type by hand as the step showed. Resulting `PresetId` type is byte-identical; the const array lets
     `domain.ts` build the preset zod enum with NO `as`-cast (honoring §9.1's no-cast rule). Additive, not a contract change.
  2. Added zod validators the step's prose requires but didn't name individually: `errorCodeSchema` (errors.ts),
     `PresetIdSchema` (domain.ts), and the ipc arg/return schemas (`platformSchema`, `ScreenSourceSchema`,
     `notificationArgSchema`, `updateInfoSchema`, `setBadgeArgSchema`, `setTokenArgSchema`, `selectSourceArgSchema`).
     Required by contract.test.ts to round-trip the ipc surface into the coverage set.
- Notes for dependents: import contract types/schemas from `@tavern/shared` (single barrel). Preset zod enum is
  `PresetIdSchema` (domain). Error zod enum is `errorCodeSchema` (errors). WS parse entrypoints:
  `parseClientMessage`/`parseServerMessage`. `ScreenSource` is both a type and `ScreenSourceSchema`.

## S0.3 — CI skeleton — 2026-07-10
- Agent: claude-opus-4-8[1m] (orchestrator, inline — needs git/gh + CI integrator judgment)
- DoD results:
  - `node scripts/check-fr-traceability.mjs` → exit 0, prints `covered 1/45` (FR-32 from S0.2)
  - `STRICT=1 node scripts/check-fr-traceability.mjs` → exit 1 (strict fails while FRs missing)
  - `ls .github/workflows/` → exactly `ci.yml` (old Tauri workflow replaced)
  - CI run GREEN: https://github.com/enheit/tavern/actions/runs/29063828011 (job `ci` 16s — install→lint→format:check→typecheck→test:coverage→build→check-fr all ✓)
- Files created/modified: .github/workflows/ci.yml (rewritten), scripts/check-fr-traceability.mjs, package.json (+check:fr script)
- Deviations: S0.3 landed as TWO commits (code `feat(S0.3)` = b094cc1, then this progress record) instead of one — the env's git guard blocks amend+force-push of already-pushed commits, and the green run URL is only known after pushing. Append-only, non-destructive; the recorded run is the S0.3 CI run watched green on the code.
- Notes for dependents: CI runs on every push to feat/electron. Node-20-deprecation annotation on checkout/setup-node/pnpm actions is cosmetic (forced to node24, non-blocking). Later steps ADD jobs to ci.yml (§11), never restructure it. Traceability STRICT flips in S12.4.

## S1.1 — Worker bootstrap (Hono + bindings + vitest-pool-workers) — 2026-07-10
- Agent: claude-opus-4-8[1m] (implementer, worktree track/backend)
- Preconditions: `grep "^## S0.3" docs/progress.md` present; `pnpm -w install --frozen-lockfile` → "Already up to date" exit 0; `wrangler whoami` → Personal Account `fd8a5f7a38f28a2cd11e79e85985c7d4` (roman.mahotskyi@gmail.com), NOT Icelook — STOP condition not triggered.
- Resource verification (task 7, read-only): `wrangler d1 list` → `tavern-db` uuid `49d52212-7fd9-4d4e-a7dd-d48f90dc0219` (pinned match); `wrangler r2 bucket list` → `tavern-media` present.
- DoD results (all 5 gates green, real output):
  - `mkdir -p app/dist && printf … > app/dist/index.html` → exit 0 (local, uncommitted, gitignored)
  - `pnpm --filter @tavern/worker test` → Test Files 1 passed (1), Tests 3 passed (3); istanbul coverage Lines 100% (4/4), Stmts 100% (6/6), Funcs 100% (3/3) — ≥80% gate met; exit 0
  - `pnpm --filter @tavern/worker exec wrangler deploy --dry-run` → exit 0; bindings SERVER_ROOM (DO), DB (tavern-db), MEDIA (tavern-media), ASSETS; `secrets.required` accepted (not rejected — STOP cond N/A)
  - `wrangler dev` (bg) + `curl http://localhost:8787/api/health` → `{"ok":true}` HTTP 200; `curl /api/nope` → `{"error":"not_found"}` HTTP 404; process killed
  - `pnpm -w lint && pnpm -w typecheck` → exit 0 (oxlint --deny-warnings clean; tsc --noEmit Done across all 5 packages incl. worker)
- Files created: worker/wrangler.jsonc, worker/src/do/ServerRoom.ts, worker/vitest.config.ts, worker/test/setup.ts, worker/test/health.test.ts, worker/.dev.vars.example, worker/migrations/.gitkeep, worker/worker-configuration.d.ts (generated via `wrangler types`, committed). Local-only (gitignored, not committed): worker/.dev.vars.
- Files modified: worker/package.json (scripts block per task 1), worker/src/index.ts (Hono app + notFound envelope + ServerRoom export), worker/tsconfig.json (include + types), pnpm-lock.yaml (worker deps), pnpm-workspace.yaml + .gitignore + .oxfmtrc.json (see Deviations).
- Deviations (real pinned-spec-vs-toolchain conflicts, intent-preserving; per integrator-judgment policy):
  1. vitest.config.ts imports `readD1Migrations` (and `cloudflareTest`) from the package ROOT `@cloudflare/vitest-pool-workers`, not the spec's `@cloudflare/vitest-pool-workers/config`. Verified: 0.18.4 exposes only `.`, `./types`, `./codemods/*` — NO `/config` subpath; both symbols are root exports. Intent (cloudflareTest plugin + readD1Migrations-fed TEST_MIGRATIONS binding) preserved exactly.
  2. worker/tsconfig.json `types: ["@cloudflare/vitest-pool-workers/types"]` not the spec's `["@cloudflare/vitest-pool-workers"]`. Empirically verified the pinned value FAILS: `tsc` emits 2× `TS2307 Cannot find module 'cloudflare:test'` (setup.ts + health.test.ts) — the `cloudflare:test` module declaration ships at the `./types` export condition in 0.18.4, not root. `/types` is the minimal fix that greens typecheck; product meaning unchanged.
  3. .gitignore: added `!.dev.vars.example` (un-ignore) so task 5's example file is committable — S0.1's `.dev.vars.*` glob otherwise ignores it. Necessary corollary of task 5.
  4. pnpm-workspace.yaml: `allowBuilds` (esbuild/sharp/workerd) + `minimumReleaseAgeExclude` (the 3 pinned recently-published CF deps) — install/build-enabling settings; `pnpm -w install --frozen-lockfile` and the pool-workers (workerd) test run are green with them present. (oxfmt normalized its string quoting; semantics unchanged.)
  5. .oxfmtrc.json: added `**/worker-configuration.d.ts` to ignorePatterns — the `wrangler types` generated file (committed per task 8) is not oxfmt-formatted and would re-break `format:check` on every regeneration; ignoring generated output mirrors S0.1's oxfmt-scoping precedent. `pnpm format:check` → exit 0 after.
- DEFERRED (not done — permission-blocked, honestly recorded): remote `wrangler secret put BETTER_AUTH_SECRET` (+ draft-worker creation + Bitwarden `tavern/BETTER_AUTH_SECRET` mirror per R7) was DENIED by the Claude Code auto-mode Secret-Store-Writes classifier; not circumvented. No DoD gate, precondition, or immediate dependent (S1.2 uses local worker/.dev.vars) needs it; `wrangler deploy` (non-dry-run) stays blocked by `secrets.required` until S7.1 provisions the 4 Realtime/TURN secrets regardless. The generated candidate value was discarded (never applied anywhere) — the real secret must be generated+provisioned+Bitwarden-stored at that point (pre-S11.1), or the user grants the Bash permission and it is redone.
- Notes for dependents: bindings live now — DB (D1), MEDIA (R2), SERVER_ROOM (DO class `ServerRoom`, migration tag v1 `new_sqlite_classes`), ASSETS (../app/dist). Worker name `tavern`, route prefix `/api`, error envelope `{ error: <ErrorCode> }` (e.g. `not_found`, `not_implemented`). Import pool-workers config helpers from the package ROOT (no `/config`). tsconfig `types` must include `@cloudflare/vitest-pool-workers/types` for `cloudflare:test`. worker/.dev.vars (gitignored) holds local dev secret values. ServerRoom is a 501 placeholder until S3.1. app/dist is a throwaway stub until S4.2 owns the real build.

## S1.2 — BetterAuth: register / login / bearer sessions — 2026-07-10
- Agent: claude-opus-4-8[1m] (implementer, worktree track/backend)
- Preconditions: `grep "^## S1.1" docs/progress.md` present (exit 0); `pnpm --filter @tavern/worker test` green pre-change (3 tests). Deps installed exact: `better-auth@1.6.23 drizzle-orm@0.45.2` (prod), `drizzle-kit@0.31.10` (dev).
- Schema pipeline (task 3): `cd worker && npx auth@latest generate --config ./auth-cli.config.ts --output ./src/db/auth-schema.ts` → "Schema was generated successfully" — 5 models incl. `rate_limit` table + `username`/`display_username` columns (STOP condition NOT triggered). `npx drizzle-kit generate` → `migrations/0000_messy_roughhouse.sql` (5 tables). `pnpm -F @tavern/worker run migrate:local` → 13 commands executed ✅.
- DoD results (all 3 gates green, real output):
  - `pnpm --filter @tavern/worker test` → Test Files 2 passed (2), Tests 18 passed (18); istanbul coverage Lines 83.96% (89/106), Stmts 84.03%, Branches 79.16%, Funcs 76.66% — ≥80% lines gate met; exit 0. Covers FR-01 register (create+set-auth-token, dup→409 username_taken, short→400 password_too_short, mismatch→400 password_mismatch, bad-username→400 bad_request, malformed-JSON→400 bad_request, no-email-leak) + FR-02 login (valid+set-auth-token, wrong-pw/unknown-user identical 401, bearer & cookie authorize requireAuth, unauth→401, getSession returns userId/username/displayName not email) + FR-02 brute force (4th /sign-in/username in 10s → 429, counter row present in `rate_limit` D1 table).
  - `grep -rn "users.tavern.invalid" app/ shared/ 2>/dev/null | wc -l` → `0`.
  - `pnpm -w lint && pnpm -w typecheck` → exit 0 (oxlint --deny-warnings clean; tsc --noEmit Done across all 5 packages). `pnpm -w format:check` → "All matched files use the correct format".
- Files created: worker/auth-cli.config.ts, worker/drizzle.config.ts, worker/src/auth.ts, worker/src/db/auth-schema.ts (generated), worker/migrations/0000_messy_roughhouse.sql (generated) + migrations/meta/ (drizzle-kit journal), worker/src/middleware.ts, worker/src/routes/register.ts, worker/test/auth.test.ts. Local-only (gitignored): worker/.dev.vars (BETTER_AUTH_SECRET dev value).
- Files modified: worker/src/index.ts (mount withAuth + stripEmail + better-auth handler + register wrapper), worker/package.json (+deps), pnpm-lock.yaml.
- Deviations (real pinned-spec-vs-toolchain conflicts, intent-preserving; integrator-judgment policy):
  1. `src/auth.ts` `createAuth` return type is INFERRED, not the pinned `ReturnType<typeof betterAuth>`. Empirically that annotation FAILS typecheck (TS2322): under `exactOptionalPropertyTypes` the concrete `Auth<withPlugins>` is not assignable to the widened `Auth<BetterAuthOptions>` — `api.signUpEmail`'s body is contravariantly incompatible (concrete requires `displayName`). Inference yields the precise instance type, which is strictly better for dependents (`ReturnType<typeof createAuth>` unchanged). No product/behaviour change.
  2. `drizzleAdapter(drizzle(env.DB, { schema }), …)` — added `{ schema }` to the pinned bare `drizzle(env.DB)`. Verified drizzle-adapter 1.6.23 resolves tables via `config.schema || db._.fullSchema` and THROWS "Schema not found" otherwise; drizzle-d1 only sets `_.fullSchema` when a schema is passed. Minimal fix, no product change.
  3. `auth-cli.config.ts` also carries the `rateLimit { storage:"database", customRules }` block (task 3 said "same plugins/additionalFields"). Required: the generator emits the `rate_limit` table only when `rateLimit.storage === "database"` (core get-tables.mjs `shouldAddRateLimitTable`), and this step's STOP condition requires that table. The stub D1 in the CLI config is never queried (generator reads only provider + plugin/field schema, verified in auth CLI dist).
  4. Task 7 asked to forward `c.executionCtx` to the better-auth handler for `ctx.waitUntil`; better-auth 1.6.23's `Auth.handler` signature is `(request: Request) => Promise<Response>` with NO context param, so there is nothing to forward. The handler is fully awaited (isolate stays live); rate-limit DB writes are awaited within the request. Documented in index.ts.
- DEFERRED (not done — permission-blocked, honestly recorded): `pnpm -F @tavern/worker run migrate:remote` (task 3, applies 0000 to the live `tavern-db`) was DENIED by the Claude Code auto-mode "Production Deploy" classifier; not circumvented. Not a DoD gate; the deploy pipeline (S12.2 `deploy.yml`) runs `wrangler d1 migrations apply tavern-db --remote` and will apply 0000 remotely then (or the user grants the Bash permission and it is redone). Local migration IS applied and the pool-workers tests apply 0000 via `readD1Migrations` so all gates pass without the remote step.
- Notes for dependents: exports `createAuth(env)` (auth.ts); `withAuth`/`requireAuth`/`zodJson`/`stripEmail` + `type AuthVars` (middleware.ts) — `withAuth` sets `c.var.auth` + `c.var.userId` (string|null); `requireAuth`→401 `unauthorized`; `zodJson(schema)`→400 `bad_request` on parse fail, stashes `c.var.validatedBody`. Register path `/api/auth-wrap/register` (wrapper, NOT rate-limited — calls `auth.api.signUpEmail` server-side); login is better-auth's own `POST /api/auth/sign-in/username` (rate-limited, keyed by `x-forwarded-for` IP + path, max 3/10s). Bearer token arrives in the `set-auth-token` response header (S5.1 client captures it). Synthetic email `${username}@users.tavern.invalid` is deep-stripped from all JSON on `/api/auth/*` + `/api/auth-wrap/*`. Auth migration is generated — never hand-edit; regen = `auth@latest generate` → `drizzle-kit generate` → `pnpm format`.
