# Development

## Prerequisites

- Node 22 (`engines` pins ≥22.12)
- pnpm **11.10.0** (`corepack enable` reads `packageManager` from package.json)
- `wrangler login` on the **personal** Cloudflare account `fd8a5f7a38f28a2cd11e79e85985c7d4`
  (never Icelook — `worker/wrangler.jsonc` pins `account_id`, and deploy.yml has a whoami guard)

## Secrets

| Name | Where it lives | Who provisions |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | worker secret (deployed) · `worker/.dev.vars` · Bitwarden `tavern` | generated at S1.2 |
| `REALTIME_APP_ID` / `REALTIME_APP_SECRET` | worker secrets · `worker/.dev.vars` · GitHub Actions · Bitwarden `tavern` | Cloudflare Realtime app `tavern-sfu` (S7.1) |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | worker secrets · `worker/.dev.vars` · GitHub Actions · Bitwarden `tavern` | Cloudflare TURN key `tavern-turn` (S7.1) |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions · Bitwarden `tavern` | deploy.yml (Workers Scripts:Edit + D1:Edit + Account Settings:Read) |
| `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | GitHub Actions (absent — §3.7 fallback active, see docs/blockers.md) | Apple Developer ID, when purchased |

Dev/test-only flags (`TAVERN_SFU_MOCK`, `TAVERN_TEST`, `TAVERN_TEST_FAST_ALARM`,
`KILL_SWITCH_DISABLED`) live in `worker/.dev.vars*` and are never deployed (see wrangler.jsonc).

## Run

```sh
pnpm i
pnpm dev   # worker `wrangler dev` (8787) + app vite dev (5173) + desktop electron-vite, in parallel; Ctrl-C stops them
```

## Test

```sh
pnpm test               # unit/integration across all packages
pnpm e2e                # Playwright web + desktop projects (mock SFU)
pnpm e2e:worker-target  # full web suite against the worker-served prod build on 8787
pnpm verify:all         # the whole gauntlet: lint, format, typecheck, coverage, build, e2e, STRICT FR matrix
```

## Release

```sh
node scripts/release.mjs X.Y.Z   # version bump + tag vX.Y.Z + push → release.yml builds 3 OSes,
                                 # publishes to GitHub Releases; running apps self-update (FR-44)
```

Web deploys are automatic: merge to `main` → ci.yml → deploy.yml (D1 migrations, then `wrangler deploy`).

## Server creation codes

Creating a server (`POST /api/servers`, FR-08) requires a one-time **creation code** on top of the
nickname + password — this gates uncontrolled server creation. Codes are seeded **by hand** by the
operator into the `server_creation_codes` D1 table (migration `0003_server_creation_codes.sql`, DB
binding `DB`, database `tavern-db`). A code is single-use: the create route claims it atomically and
records who used it, when, and which server it created; a spent or unknown code returns
`403 { "error": "invalid_code" }`. The `/join` page's "Create my own server" dialog collects the
code from the user.

Seed one **locally** (the migration ships with `pnpm dev`; apply it standalone with
`pnpm -F @tavern/worker migrate:local`). `wrangler d1 execute` must run from `worker/` so it finds
`wrangler.jsonc` — `pnpm -F @tavern/worker exec` does that for you:

```sh
pnpm -F @tavern/worker exec wrangler d1 execute tavern-db --local \
  --command "INSERT INTO server_creation_codes (code, created_at) VALUES ('LET-ME-IN', $(date +%s000))"
```

Seed one in **production** (`--remote`; the table is created by deploy.yml's migration step, or run
`pnpm -F @tavern/worker migrate:remote`). Use a literal epoch-ms for `created_at`:

```sh
pnpm -F @tavern/worker exec wrangler d1 execute tavern-db --remote \
  --command "INSERT INTO server_creation_codes (code, created_at) VALUES ('LET-ME-IN', 1752000000000)"
```

Check whether a code has been spent (`used_at IS NULL` = still valid):

```sh
pnpm -F @tavern/worker exec wrangler d1 execute tavern-db --remote \
  --command "SELECT code, used_by_user_id, used_at, created_server_id FROM server_creation_codes"
```

Tests never need manual seeding: e2e/soak mint codes through the test-only
`POST /api/__test/seed-code` route (present only when `TAVERN_TEST=1` — the mock e2e worker and the
nightly real-SFU worker; never production). The deployed smoke drives the REAL deployment, so it has
its own runner that mints an **ephemeral** code via your wrangler auth, burns it in the test, and
deletes it afterwards if unused — no standing codes are ever provisioned for smoke runs:

```sh
node e2e/scripts/deployed-smoke.mjs --base https://tavern.roman-mahotskyi.workers.dev
```

## Deep links

- [docs/PLAN.md](PLAN.md) — the pinned implementation plan (source of truth)
- [docs/progress.md](progress.md) — per-step evidence ledger
- [docs/blockers.md](blockers.md) — open/resolved blockers
- [../soak-report.json](../soak-report.json) — latest 10-client soak result (S12.3)
