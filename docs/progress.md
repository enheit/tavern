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
