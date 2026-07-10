# S12.4 — Full regression matrix + close-out

- after: ALL other steps (S0.1–S12.3)
- unlocks: — (final step)
- FRs: ALL (FR-01…FR-45 — this step proves the traceability matrix, PLAN §13)
- references: PLAN §0.3, §1.9, §10 (coverage numbers), §11, §13

## Goal

One command proves the whole product: every gate green, every FR evidenced by a named test,
non-goals verifiably absent, docs good enough for a cold start. Nothing new is built here.

## Preconditions (run these; red = STOP)

- Every step S0.1–S12.3 has a green entry: for each id,
  `grep -q '## S<id> ' docs/progress.md` → exit 0 (script the loop; list any missing → STOP)
- `grep -c 'STATUS: OPEN' docs/blockers.md` → `0`

## Tasks

1. **Coverage thresholds audit**: confirm each package's vitest config enforces PLAN §10 numbers —
   `shared ≥90`, `worker ≥80`, `app ≥70` + `app/src/media ≥85` (per-directory threshold entry),
   `desktop ≥70`. A missing/lower threshold is a plan violation introduced earlier → fix the
   config (raising only), never the number. Also confirm `@tavern/app` (S4.2) and `@tavern/desktop`
   (S4.1) each have a `"test:coverage": "vitest run --coverage"` script — without it, `pnpm
   test:coverage` (`-r --if-present`) silently skips exactly the two packages this audit checks; add
   the missing script if absent.
2. **Root gauntlet script** — add to root `package.json` (composition pinned; sub-scripts must
   already exist from earlier steps, verbatim names — `e2e` from S4.4, `check:fr` from S0.3):
   `"verify:all": "pnpm lint && pnpm format:check && pnpm typecheck && pnpm test:coverage && pnpm build && pnpm e2e && STRICT=1 pnpm check:fr"`
3. **Traceability STRICT run**: `STRICT=1 pnpm check:fr` must fail on ANY of FR-01…45
   missing from a `describe()` in the repo; fix gaps by finding the existing test that proves the
   FR and tagging it — if no test proves an FR, that is a plan bug: file a blocker, do NOT write a
   sham test.
4. **Non-goal greps** (PLAN §1.9 — all three must return NOTHING):
   - `git grep -niE 'editMessage|deleteMessage|messageReaction' -- app/src worker/src shared/src`
   - `git grep -niE 'typingIndicator|isTyping' -- app/src worker/src shared/src`
   - `git grep -niE '/api/dm|directMessage' -- app/src worker/src shared/src`
5. **Nightly proof** (nightly.yml is CREATED in S12.2 with an `on: workflow_dispatch` trigger, so
   this dispatch is accepted):
   `gh workflow run nightly.yml && sleep 10 && gh run watch $(gh run list --workflow=nightly.yml --limit 1 --json databaseId -q '.[0].databaseId') --exit-status`
   — the `@realtime` media suites, 3-OS packaged boot-smoke, Void container AND Ubuntu 24.04
   AppImage jobs all green.
6. **README.md** (final, pinned outline): what Tavern is (2 lines) → prerequisites (Node 22,
   pnpm 11.10.0, wrangler login on account `fd8a5f7a…`) → secrets table (name / where it lives /
   who provisions — mirror S12.2's ledger) → `pnpm i` → `pnpm dev` (S0.1's root script
   `"dev": "pnpm -r --parallel --if-present dev"` — runs worker `wrangler dev` (8787), app vite dev
   (5173), and desktop electron-vite in parallel; Ctrl-C stops them) → test commands (`pnpm test`,
   `pnpm e2e`, `pnpm e2e:worker-target`, `pnpm verify:all`) → release process
   (`node scripts/release.mjs X.Y.Z`) → deep links: PLAN.md, progress.md, soak-report.json.
7. **Blockers ledger close**: every resolved entry in docs/blockers.md gets `STATUS: RESOLVED
   (<date>, <how>)`; OPEN entries block this step (precondition).
8. **Final progress.md entry** — reproduce the §13 matrix with evidence, pinned row format:
   `| FR-xx | <test file path> | '<describe string>' |` — one row per FR, 45 rows, plus the
   verify:all output tail and the nightly run URL.

## Pinned interfaces & artifacts

- Root script `verify:all` exactly as in Task 2.
- README.md per Task 6 outline.
- No other files change (except the coverage configs / `test:coverage` scripts fixed by Task 1 and
  the test `describe` tags from Task 3).

## Tests

No new tests — this step RUNS them all. The only new executable artifact is `verify:all`.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm verify:all` → exit 0 (paste the final summary lines of each stage into progress.md)
- [ ] `STRICT=1 pnpm check:fr` → prints `covered 45/45` (exact output pinned by S0.3's script)
- [ ] All three non-goal greps (Task 4) → empty output
- [ ] `gh workflow run nightly.yml && sleep 10 && gh run watch $(gh run list --workflow=nightly.yml --limit 1 --json databaseId -q '.[0].databaseId') --exit-status` → exit 0; run URL in progress.md
- [ ] Final progress.md entry contains the 45-row evidence matrix
- [ ] `grep -c 'STATUS: OPEN' docs/blockers.md` → `0`

## STOP conditions (beyond global R1)

- Any FR without a real proving test (Task 3) → blocker naming the FR and the missing behavior.
- Any coverage threshold found below PLAN §10 numbers → fix upward only; if the suite can't reach
  the number, blocker — never lower it (R4).
- Nightly red on exactly one platform → blocker with the failing job log; do not mark the step
  done "except for X".

## Docs (consult only these)

- PLAN.md §10, §11, §13 (this step is self-referential by design)
- https://cli.github.com/manual/gh_workflow_run
