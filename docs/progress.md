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

## S4.1 — Electron shell (main + preload, typed IPC, security baseline) — 2026-07-10
- Agent: claude-opus-4-8[1m] (implementer, worktree track/client)
- Preconditions: `pnpm -F @tavern/shared test` → 5 files/16 tests passed (exit 0); `node -e "...process.version /^v2[2-9]/"` → exit 0 (v24.13.1).
- DoD results (all gates green, real output):
  - `pnpm -F @tavern/desktop test -- --coverage` → exit 0; Test Files 12 passed (12), Tests 70 passed (70); istanbul coverage Lines 90.99% (192/211), Stmts 91.22%, Branch 94.68%, Funcs 90.54% — ≥70% gate met. (Only `src/main/index.ts` — the top-level startup orchestrator with import-time side effects — is uncovered by design.)
  - `pnpm -F @tavern/desktop build` → exit 0; `out/main/index.js` (169 KB) + `out/preload/index.js` (159 KB) exist. electron-vite prints "renderer config is missing" — a WARNING, not a failure; the build succeeded, so the STOP-condition renderer-stub contingency was NOT triggered.
  - `pnpm typecheck && pnpm lint` → exit 0 (tsc --noEmit Done across all 5 packages; `oxlint --deny-warnings` clean). `pnpm format:check` → exit 0 ("All matched files use the correct format").
  - Manual evidence (per repo verification rule): launched the BUILT shell with `TAVERN_RENDERER_URL='data:text/html,<title>Tavern</title><h1>shell ok</h1>'`. `screencapture` is unavailable in this headless env ("could not create image from display" — no display/screen-recording access), so I verified the running renderer via the Chrome DevTools Protocol instead (stronger than a pixel screenshot — it reads the live DOM + bridge state). CDP readback from the real window: `document.title="Tavern"`, `document.body.innerText="shell ok"` (placeholder loaded), `typeof window.tavern="object"`, `Object.keys(window.tavern)=capture,notifications,platform,secrets,shell,updates`, `window.tavern.platform="darwin"`, and `window.require`/`window.ipcRenderer` BOTH `undefined` — i.e. contextIsolation+sandbox+nodeIntegration:false and checklist #20 (no raw ipc leak) confirmed at runtime. `electron-vite dev` also launched the same window (main + Renderer helper processes, GUI process "Electron"). Logs: /tmp/tavern-dev.log, /tmp/tavern-cdp.log.
- Files created: desktop/electron.vite.config.ts, desktop/vitest.config.ts, desktop/src/main/{index,window,protocol,singleInstance,ipc,permissions,capture,flags,notifications,secrets,updates}.ts, desktop/src/preload/index.ts, desktop/test/electron-mock.ts + 12 test files (ipc, permissions, capture, loopback, secrets [5 required] + protocol, window, notifications, updates, singleInstance, flags, preload [7 added to robustly clear the ≥70% gate — additive, never weakening]).
- Files modified: desktop/package.json (pinned deps + scripts + `main`), desktop/tsconfig.json (`types:["node"]`), pnpm-workspace.yaml (electron→allowBuilds), pnpm-lock.yaml. Removed: desktop/src/index.ts (S0.1 placeholder, superseded — main is now src/main/index.ts).
- Deviations (real pinned-spec-vs-toolchain conflicts, tooling-only, intent-preserving; per integrator-judgment policy — none is a product/architecture decision):
  1. Added `@tavern/shared` (workspace:*) + `zod@4.4.3` to desktop deps. Not in task 1's `-DE` list, but tasks 3/4 mandate importing @tavern/shared and zod-parsing IPC payloads. zod is pinned §3.3; @tavern/shared is the contract source. Additive plumbing, not a new dep decision.
  2. desktop/package.json omits `"type":"module"` and `exports` (S0.1 had both). Dropped so electron-vite emits CJS main/preload — the Electron entry needs CJS `__dirname` for protocol.ts's unpackaged renderer path (task 3); ESM output would break it. `exports` removed because desktop is an app (nothing imports it). Matches the step's package.json spec (name/private/`main`/scripts), which lists neither.
  3. electron.vite.config.ts adds `build.externalizeDeps:false` to BOTH main and preload (beyond the pinned minimal `{outDir,lib.entry}` + prose target:node24 / externalize-electron). Required by observed toolchain reality: electron-vite 5 externalizes `dependencies` by default, but @tavern/shared is TS source with extensionless imports Node cannot require at runtime (reproduced ERR_MODULE_NOT_FOUND on `./limits`), and a sandbox:true preload cannot require third-party npm modules at all. externalizeDeps:false bundles zod+@tavern/shared into each output; only electron + node builtins stay external. Architecture (external renderer, main+preload only) unchanged.
  4. vitest.config.ts adds `coverage.enabled:true` to the pinned coverage block. The DoD command `vitest run -- --coverage` has the flag AFTER `--`, which vitest's cac parser treats as a positional — so coverage never runs from the flag. Enabling it in config makes the VERBATIM pinned command actually run coverage and enforce the pinned ≥70% threshold. provider/include/thresholds unchanged.
  5. pnpm-workspace.yaml adds `electron: true` to `allowBuilds` (mirrors S1.1's build-enabling precedent for esbuild/sharp/workerd). Electron's postinstall (binary download) is a gated build script; without the binary `electron-vite dev` fails with "Electron uninstall". Install-enabling only. Had to run electron's `install.js` once to fetch the binary (an already-installed tree does not re-trigger it).
  6. preload/index.ts exports a `bridgeInstalled=true` sentinel so preload.test.ts imports the side-effecting module as an assigned import (oxlint import/no-unassigned-import is correctness=error and rejects bare `import "…"`). Harmless build-time export; does not touch window.tavern.
- Notes for dependents: `window.tavern` is live (S4.3 renderer platform/electron.ts implements the same TavernIpc surface — keys: platform, secrets, capture, notifications, updates, shell). IPC surface FROZEN: 9 invoke channels (`secrets:getToken/setToken`, `capture:getScreenSources/selectSource/loopbackAudioSupported`, `notifications:show`, `updates:restartToUpdate`, `shell:setBadge/focusWindow`) + 2 push channels (`notifications:clicked`, `update://ready`). Main validates sender-frame origin (`app://tavern` or `TAVERN_RENDERER_URL`) then zod-parses args; preload zod-parses inbound payloads; raw ipcRenderer never exposed. Env contract: `TAVERN_RENDERER_URL`, `TAVERN_E2E`, `TAVERN_USER_DATA`, `TAVERN_FAKE_AUDIO`. Dev loads TAVERN_RENDERER_URL else `app://tavern/index.html` (S4.4 exercises the real @tavern/app renderer over app:// once S4.2 lands). Frozen v1 stubs owned elsewhere: updates.ts body → S12.2 (same `update://ready` string); capture loopback matrix (win32/darwin true, linux false) + macOS audio probe → S8.1. Fresh checkouts: `pnpm rebuild electron` (or run electron/install.js) to fetch the binary.
