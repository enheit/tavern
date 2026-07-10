# S0.3 — CI skeleton (GitHub Actions + FR-traceability gate)

- after: S0.2
- unlocks: all steps (every later DoD relies on this pipeline running their gates)
- FRs: — (infrastructure; the traceability script guards ALL FRs at S12.4)
- references: PLAN §10 (gates), §11 (ci.yml scope), §13 (FR list)

## Goal

One CI workflow that runs install → lint → format check → typecheck → tests-with-coverage →
build → FR-traceability on every PR and push to `feat/electron`. Later steps append jobs
(e2e, nightly, release) — they extend this file, they do not restructure it.

## Preconditions (run these; red = STOP)

- `pnpm -F @tavern/shared test:coverage` → exit 0 (S0.2 green)
- `gh auth status` → authenticated (needed to observe the run for the DoD)

## Tasks (numbered, imperative, zero alternatives)

1. Create `scripts/check-fr-traceability.mjs` per the contract below.
2. Add root package.json script `"check:fr": "node scripts/check-fr-traceability.mjs"`.
3. Create `.github/workflows/ci.yml` exactly as pinned below (replacing any leftover workflow
   files from the abandoned Tauri implementation — delete every other file in
   `.github/workflows/`).
4. Commit (`feat(S0.3): CI skeleton`), push, watch the run by explicit id (a bare
   `gh run watch` errors in a non-TTY agent shell, and the run may not be registered for a second
   after push):
   `git push && sleep 10 && gh run watch "$(gh run list --branch feat/electron --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`.
5. Progress entry including the green run URL.

## Pinned interfaces & artifacts

`scripts/check-fr-traceability.mjs` — plain Node ≥22, zero dependencies (`node:fs`,
`node:path` only). Contract:

- Recursively collects `*.test.ts`, `*.test.tsx`, `*.spec.ts` files under `shared/`, `worker/`,
  `app/`, `desktop/`, `e2e/`, skipping any path segment named `node_modules`, `dist`, `out`,
  `coverage`.
- Extracts every match of `/FR-\d{2}/g` from file contents into a covered-set.
- Expected set: `FR-01` … `FR-45` (generate, don't enumerate).
- Prints one line per missing FR (`MISSING FR-xx`), then a final summary line `covered N/45`
  (literally `covered 45/45` once every FR is traced). Both the script name (`check:fr`) and this
  `covered N/45` string are the contract S12.4's STRICT gate asserts against — do not rename either.
- Exit code: `0` always, UNLESS `process.env.STRICT === '1'` and the missing set is non-empty →
  exit `1`. (S12.4 flips STRICT in CI via `STRICT=1 pnpm check:fr`; until then the step is informational.)

`.github/workflows/ci.yml` (complete):

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [feat/electron, main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4          # reads packageManager from package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm typecheck
      - run: pnpm test:coverage
      - run: pnpm build
      - run: node scripts/check-fr-traceability.mjs
```

Structural pins for later steps (do not implement now, do not violate later):
- e2e jobs (S4.4+) are ADDED as separate jobs in this file (`e2e-web`, `e2e-desktop` with xvfb).
- The worker package owns its own WS-test flags: its `test` script internally runs the WS project
  with `--max-workers=1 --no-isolate` (S3.1's job) — CI only ever calls package scripts.
- Nightly and release live in separate workflow files — `nightly.yml` is created in S12.2 — not here.
- S12.1 APPENDS a 3-OS `package-check` job to this file, gated
  `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` (PLAN §11: every commit to
  main proves all desktop platforms package). `deploy.yml` (S12.2) waits on this workflow's
  conclusion via `workflow_run` — that is why deploy logic never lives in this file.
- The traceability step gains `env: { STRICT: '1' }` only in S12.4.

## Tests

The script is its own test via DoD gates below (deterministic I/O, no unit-test file — it is
exercised on every CI run).

## DoD gates (verbatim, from repo root)

- [ ] `node scripts/check-fr-traceability.mjs` → exit 0, prints `covered 1/45` (FR-32 from S0.2)
- [ ] `STRICT=1 node scripts/check-fr-traceability.mjs; test $? -eq 1` → exit 0 (strict mode
      correctly fails while FRs are missing)
- [ ] `git push && sleep 10 && gh run watch "$(gh run list --branch feat/electron --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`
      → CI run concludes success; run URL recorded in progress.md
- [ ] `ls .github/workflows/` → exactly `ci.yml`

## STOP conditions (beyond global R1)

- `pnpm/action-setup@v4` fails to resolve pnpm from `packageManager` → blocker (do not hardcode a
  differing pnpm version in the workflow).
- The repo has branch-protection or Actions-permission errors you cannot resolve with `gh` →
  blocker naming the exact setting a human must flip.

## Docs (consult only these)

- https://pnpm.io/continuous-integration#github-actions
- https://github.com/pnpm/action-setup
