# S12.3 — Cost kill-switch verification + 10-client soak

- after: S8.5, S9.2, S12.2 (modifies `nightly.yml`, created in S12.2)
- unlocks: S12.4
- FRs: — (verifies PLAN §8 guardrails G1/G5 end-to-end; G4 verified in S8.5)
- references: PLAN §8, §10 (hermeticity split), §App-B (egressWarnGB 700 / egressKillGB 900), §5.2 (egress_log)

## Goal

Prove the cost guardrails actually fire: warning banner at 700 GB/month estimated egress, new
pulls rejected at 900 GB while voice stays alive; and prove the whole stack holds 10 concurrent
clients (the product's worst case) without disconnects.

## Preconditions (run these; red = STOP)

- `grep -q "^## S8.5" docs/progress.md && grep -q "^## S9.2" docs/progress.md && grep -q "^## S12.2" docs/progress.md` → exit 0
- `grep -q 'egressWarnGB' shared/src/limits.ts && grep -q 'egressKillGB' shared/src/limits.ts` → exit 0
- `test -f .github/workflows/nightly.yml` → exit 0 (created in S12.2; this step appends the `soak` job)

## Tasks

1. **Test-only egress seeding** — two pinned pieces (a browser e2e cannot hit a DO internal
   route directly; S3.1 pins that the DO's only ingress is the Worker with `X-Tavern-Internal: 1`):
   - DO internal route `POST /internal/test/set-egress` body `{ month: 'YYYY-MM', bytes: number }`
     → upserts `egress_log`. Guard (pinned): the handler first checks `env.TAVERN_TEST === '1'`;
     otherwise responds 404 with no body. (Dispatch lives in `worker/src/do/ServerRoom.ts`;
     `costMeter.ts` holds the handler.)
   - Worker-facing forwarder — extend S8.5's `worker/src/routes/testSeed.ts` with
     `POST /api/__test/set-egress { serverId, month, bytes }`, guarded by `env.TAVERN_TEST === '1'`
     (404 otherwise), forwarding to the addressed ServerRoom's `/internal/test/set-egress` with the
     `X-Tavern-Internal: 1` header. **The e2e seeds through this route.**

   `TAVERN_TEST=1` lives ONLY in `worker/.dev.vars` / `worker/.dev.vars.e2e` — it is never set as a
   deployed secret (add it to the "never deploy" comment block in `worker/wrangler.jsonc`).
2. **Warning banner UI** (pinned): dismissible amber banner across the header, shown on
   `cost.warning { usedGB, capGB }`; i18n key `cost_warning_banner` (en: "Streaming has used
   {usedGB} GB of the {capGB} GB monthly budget — new watches stop at the cap.", uk: "Стрімінг
   використав {usedGB} ГБ із {capGB} ГБ місячного бюджету — нові перегляди зупиняться на ліміті.").
   Rendered as `m.cost_warning_banner({ usedGB, capGB })`. Dismissal is per-session (store flag,
   no persistence).
3. **Kill-cap client handling** (wired in `app/src/features/streams/useWatch.ts`, extending its
   `cost_cap` error-frame branch from S8.2): `watch.start` rejected with `error{code:'cost_cap'}` →
   toast `m.cost_cap_toast()` (en: "Monthly streaming budget reached — watching is paused until
   next month.", uk: "Місячний бюджет стрімінгу вичерпано — перегляд призупинено до наступного
   місяця."); no pull session is created.
4. **Kill-switch e2e** `e2e/web/killswitch.spec.ts` (runs with `TAVERN_SFU_MOCK=1` +
   `TAVERN_TEST=1`, two contexts, one fake share active).
5. **Soak script** `e2e/scripts/soak.mjs` — plain Node importing
   `{ chromium } from '@playwright/test'` (the library API is re-exported by the test runner; it is
   installed in the `e2e` workspace package, so the script MUST live under `e2e/` to resolve it —
   §3 lists no root `playwright` dependency):
   - Args (pinned): `--clients 10 --minutes 10 --base http://localhost:8787` and `--realtime`
     (nightly variant: real SFU, `--minutes 3`).
   - Startup: unless `--base` is already reachable (`GET /api/health` → 200), soak.mjs spawns
     `pnpm -F @tavern/worker dev` (env e2e: `TAVERN_SFU_MOCK=1` + `TAVERN_TEST=1`), waits on
     `/api/health`, and tears the process down on exit.
   - Flow: register 10 users via API → all join one server → open 10 headless contexts launched with
     `chromium.launch({ channel: 'chromium', headless: true, args: [<S4.4's fake-media flags>] })`
     (channel `chromium` is MANDATORY — the headless shell has no media capture, §10) + tone WAV →
     all join voice → clients 1 and 2 start fake screen shares → every client watches both shares →
     hold for the duration, pinging stats every 30s.
   - Collected (pinned report shape, saved to `soak-report.json` + printed as a table):
     `{ clients, durationMs, wsDisconnects, reconnects, errorCount, errors: string[],
     statsLatencyMsFinal }`.
   - Pass criteria (pinned): `wsDisconnects === 0`, `errorCount === 0`,
     `statsLatencyMsFinal < 500` (final `GET /api/servers/:id/stats`).
6. **Nightly wiring**: append a `soak` job to `.github/workflows/nightly.yml` (CREATED in S12.2) —
   runs `node e2e/scripts/soak.mjs --realtime --minutes 3` against the deployed preview. Soak never
   runs in PR CI (pinned).
7. **Free-plan math advisory** (goes into this step's progress.md entry, for Roman): show the
   arithmetic for DO free-cap headroom, pinned skeleton — incoming WS messages count raw
   (pre-20:1) against the 100k/day free DO request cap:
   `10 users × (chat + presence + voice/stream events + watch ops) ≈ N msgs/day` using measured
   counts from the soak run extrapolated to an 8h gaming day; compare N to 100,000; state the
   conclusion (expected: fits, but a heavy weekend approaches the cap → recommend Workers Paid
   $5/mo before real usage).

## Pinned interfaces & artifacts

- DO route: `POST /internal/test/set-egress` `{ month: string, bytes: number }` → `200 {}` |
  `404` when `env.TAVERN_TEST !== '1'`. Worker forwarder: `POST /api/__test/set-egress`
  `{ serverId, month, bytes }` (same guard).
- Files created: `app/src/features/shell/CostBanner.tsx`, `e2e/web/killswitch.spec.ts`,
  `e2e/scripts/soak.mjs`, `worker/test/costmeter-guard.test.ts`.
- Files modified: `worker/src/do/costMeter.ts` (set-egress handler — meter logic exists since
  S7.1), `worker/src/do/ServerRoom.ts` (internal-route dispatch), `worker/src/routes/testSeed.ts`
  (Worker forwarder — S8.5 owns the file), `worker/wrangler.jsonc` (TAVERN_TEST never-deploy note),
  `worker/.dev.vars` + `worker/.dev.vars.e2e` (`TAVERN_TEST=1`),
  `app/src/features/streams/useWatch.ts` (cost_cap → toast), `.github/workflows/nightly.yml`
  (append the `soak` job), `app/messages/en.json`, `app/messages/uk.json` (keys
  `cost_warning_banner`, `cost_cap_toast`).
- `soak-report.json` schema as in Task 5 (S12.4's README references it).

## Tests

- `worker/test/costmeter-guard.test.ts` — `describe('§8 egress test route guard')`: without
  `TAVERN_TEST` binding the route returns 404 (this test runs in the standard worker vitest
  project, which deliberately does NOT set `TAVERN_TEST`); meter math unit cases already exist
  from S7.1 — do not duplicate.
- `e2e/web/killswitch.spec.ts` — `describe('§8 cost guardrails')`:
  1. client A watches the fake share → seed `bytes = 700_000_000_000` (700 GB, decimal — the meter
     compares in decimal GB, §8) via `POST /api/__test/set-egress` → the next meter tick broadcasts
     `cost.warning` → the amber banner appears on BOTH clients; dismiss hides it for the session;
  2. seed `bytes = 900_000_000_000` (900 GB) → client B `watch.start` → `cost_cap` toast, no pull
     session created (assert via the `TAVERN_E2E` pull-session test hook), the already-running watch
     from step 1 keeps its state;
  3. client B leaves + rejoins voice successfully (voice-stays-up AC, PLAN §8 G5).

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/worker test` → green (incl. guard 404 test)
- [ ] `pnpm -F @tavern/e2e test --project=web --grep 'cost guardrails'` → green
- [ ] `node e2e/scripts/soak.mjs --clients 10 --minutes 10` (self-spawns local `wrangler dev`, mock SFU per Task 5) → exits 0, prints table, `soak-report.json` shows `wsDisconnects: 0`, `errorCount: 0`, `statsLatencyMsFinal < 500`; paste the table into progress.md
- [ ] `git grep -n 'TAVERN_TEST' worker/wrangler.jsonc worker/src` → appears only in the guard check + comment, never in a deploy config value
- [ ] Free-plan arithmetic paragraph present in this step's progress.md entry

## STOP conditions (beyond global R1)

- The seeding route is reachable without `TAVERN_TEST=1` in ANY configuration → security blocker, fix before anything else.
- Soak shows any WS disconnect or reconnect at 10 clients → blocker with the soak report attached (this is the product's core load promise — do not rationalize it).
- Kill-cap rejection leaks a created-then-torn-down pull (hook shows a transient session) → blocker (G1 requires rejection BEFORE SFU ops).

## Docs (consult only these)

- https://developers.cloudflare.com/durable-objects/platform/pricing/ (free-cap + 20:1 billing note)
- https://developers.cloudflare.com/realtime/pricing/ (egress pricing the meter models)
- https://playwright.dev/docs/library (script-mode Playwright for soak.mjs)
