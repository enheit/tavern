# Tavern

Discord-style voice/screen-share app for one small friend group: Electron desktop client + a
worker-served web client, chat, voice, multi-stream screen share, soundboard — all on Cloudflare
(Workers, Durable Objects, D1, R2, Realtime SFU). Production: <https://tavern.roman-mahotskyi.workers.dev>.

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

## Deep links

- [docs/PLAN.md](docs/PLAN.md) — the pinned implementation plan (source of truth)
- [docs/progress.md](docs/progress.md) — per-step evidence ledger
- [soak-report.json](soak-report.json) — latest 10-client soak result (S12.3)
