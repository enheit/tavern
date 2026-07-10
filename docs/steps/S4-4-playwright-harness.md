# S4.4 — Playwright harness + smoke suites (web & desktop)

- after: S4.3, S4.1, S1.1
- unlocks: S5.1 (every later e2e builds on this harness)
- FRs: FR-43 (smoke-level)
- references: PLAN §10 (Electron e2e pinned patterns, hermeticity split), §11 (ci.yml), §14
  (wrangler-dev rebuild instability)

## Goal

Create `@tavern/e2e`: the Playwright 1.61.1 harness every later step reuses — fixtures for users/
servers, two-client contexts, desktop launching with the pinned fake-media pattern, committed
media fixtures — plus web and desktop smoke specs proving the pipeline in CI.

## Preconditions (run these; red = STOP)

- `pnpm -F @tavern/worker dev & sleep 5 && curl -sf http://localhost:8787/api/health` → HTTP 200
  (S1.1 green; kill the dev server after)
- `pnpm -F @tavern/desktop build && pnpm -F @tavern/app build` → exit 0

## Tasks

1. Modify `e2e/package.json` (created by S0.1): add script `test`: `playwright test` — KEEP the
   S0.1 `typecheck` script that root `pnpm typecheck` relies on. Install:
   `pnpm -F @tavern/e2e add -DE @playwright/test@1.61.1`; `pnpm -F @tavern/e2e exec playwright
   install chromium` (+ `--with-deps` only in CI).
2. `e2e/playwright.config.ts` (pinned):
   - `projects`: `web` (testMatch `web/**`, `use: { channel: 'chromium', baseURL: WEB_URL,
     permissions: ['microphone','camera'], launchOptions: { args: [
     '--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',
     '--use-file-for-fake-audio-capture=<repo>/e2e/fixtures/tone-440hz-10s.wav'] } }`) —
     `channel:'chromium'` is MANDATORY (headless shell has no media capture, §10); `desktop`
     (testMatch `desktop/**`, no browser fixtures). These four are the canonical project names
     every later step uses: `web`, `desktop` (defined here), plus `web-realtime` (added by S7.4)
     and `web-worker` (added by S11.1). No step ever uses `web-chromium` — that name does not
     exist.
   - `webServer`: `[ { command: 'pnpm -F @tavern/worker dev', url:
     'http://localhost:8787/api/health', reuseExistingServer: !process.env.CI },
     { command: 'pnpm -F @tavern/app dev', url: 'http://localhost:5173',
     reuseExistingServer: !process.env.CI } ]`.
   - `retries: process.env.CI ? 1 : 0` (§14 — retry>1 is a bug, not a knob), `fullyParallel:
     false`, `workers: 1` (shared wrangler state).
   - URL constants (frozen): `WEB_URL = 'http://localhost:5173'` (PR target),
     `WORKER_URL = 'http://localhost:8787'` (worker-served parity target — S11.1 flips a suite to
     it; the harness builds the app BEFORE wrangler starts for that target and restarts wrangler
     after any rebuild — never rely on hot reload, §14).
3. `e2e/harness/fixtures.ts` — `test.extend` fixtures (frozen names):
   `api` (REST factory: `createUser(prefix)` → unique `u_<prefix>_<hex6>` + password
   `pw-<hex8>`, `createServer(admin, {password?})`, `join(user, nickname, password?)` — all via
   `/api/*` against the active target), `twoContexts` (two isolated browser contexts, each
   logged in as a fresh user, both joined to a fresh server, pages at `/s/:id`).
4. `e2e/harness/desktop.ts` — `launchDesktop({ instance, user })`:
   `_electron.launch({ args: ['.'], cwd: 'desktop', env: { ...process.env, TAVERN_E2E: '1',
   TAVERN_USER_DATA: <mkdtemp per instance>, TAVERN_FAKE_AUDIO:
   <abs>/e2e/fixtures/tone-440hz-10s.wav, TAVERN_RENDERER_URL: 'http://localhost:5173' } })`.
   Flags flow through main-process `appendSwitch` (S4.1), NOT launch args (§10 trap).
   Packaged-binary mode (used by S12.1's packaged smoke): when env `TAVERN_DESKTOP_BINARY` is
   set, launch with `_electron.launch({ executablePath: process.env.TAVERN_DESKTOP_BINARY, env: … })`
   instead of `args:['.']` — same env contract, no cwd. Returns
   `{ app, page }`; helper `closeAll()`.
5. `e2e/scripts/gen-fixtures.mjs` — regenerates committed fixtures (node stdlib only):
   `fixtures/tone-440hz-10s.wav` = RIFF PCM, 48 kHz mono 16-bit, 440 Hz sine, amplitude 0.5, 10 s
   (~960 KB; RMS ≈0.35 — comfortably above the §App-B speaking threshold; default fake-device
   beeps do NOT trip it, which is the whole point);
   `fixtures/motion-160x120.y4m` = 160×120, 15 fps, 2 s, frame color alternating each 500 ms
   (~900 KB; motion so encoders emit frames). Fixtures are COMMITTED; script kept for regen.
6. Smoke specs:
   - `e2e/web/smoke.spec.ts` — `describe('FR-43 web smoke')`: cold load `/` → `boot-loader`
     appears → lands on `page-login` with no other `page-*` testid ever attached (flash guard).
     (No language-switch assertion here — the login page has no locale control at this milestone;
     the language select lands in S6.2's Settings dialog and is e2e-tested there.)
   - `e2e/desktop/smoke.spec.ts` — `describe('FR-43 desktop smoke')`: `launchDesktop` → first
     window title `Tavern`, `boot-loader` then `page-login` visible; second instance with its own
     `TAVERN_USER_DATA` launches concurrently (single-instance lock skipped under E2E).
7. CI (`.github/workflows/ci.yml` — modify): after build jobs, add
   `e2e-web`: `pnpm -F @tavern/e2e exec playwright install --with-deps chromium` then
   `pnpm -F @tavern/e2e test --project=web`;
   `e2e-desktop`: `xvfb-run --auto-servernum -- pnpm -F @tavern/e2e test --project=desktop`
   (ubuntu-latest; desktop+app built first). Playwright HTML report uploaded as artifact on
   failure.

## Pinned interfaces & artifacts

- Fixture names frozen: `api`, `twoContexts`, `launchDesktop` — later steps extend, never rename.
- Fixture files frozen: `e2e/fixtures/tone-440hz-10s.wav`, `e2e/fixtures/motion-160x120.y4m`.
- Test-id contract consumed here (from S4.2): `boot-loader`, `page-login`.
- Root `package.json` script pinned here: `"e2e": "pnpm -F @tavern/e2e exec playwright test
  --project=web --project=desktop"` (the PR gate — web+desktop only). `e2e:realtime` and
  `e2e:worker-target` are added later by S7.4/S11.1 alongside their projects.
- Files created: `e2e/` package (config, harness/ helpers, scripts/, fixtures/, web/smoke.spec.ts,
  web/harness.spec.ts, desktop/smoke.spec.ts); modified: `.github/workflows/ci.yml`, root
  `package.json` (add the `e2e` script above).

## Tests

This step IS tests; the named cases above. Harness code itself gets one unit check at
`e2e/web/harness.spec.ts` (under `web/**` so the `web` project actually runs it) —
`describe('harness self-test')`: `api.createUser` twice yields distinct usernames; WAV fixture
header parses as 48 kHz mono PCM (read bytes 22–28).

## DoD gates (verbatim, from repo root)

- [ ] `node e2e/scripts/gen-fixtures.mjs && git diff --exit-code e2e/fixtures` → exit 0
      (committed fixtures reproducible)
- [ ] `pnpm -F @tavern/e2e test --project=web` → exit 0
- [ ] `pnpm -F @tavern/desktop build && pnpm -F @tavern/e2e test --project=desktop` → exit 0
      (linux: prefix with `xvfb-run --auto-servernum --`)
- [ ] CI run on the PR shows `e2e-web` and `e2e-desktop` jobs green
- [ ] `pnpm typecheck && pnpm lint` → exit 0

## STOP conditions (beyond global R1)

- `_electron.launch` times out against the DEV (unpackaged) app → STOP (this is the §10
  nodeCliInspect-fuse symptom only for packaged builds; in dev it means a real harness bug —
  do not add sleeps).
- Smoke needs >1 retry in CI to pass → STOP and fix the flake (§14 pinned rule).

## Docs (consult only these)

- https://playwright.dev/docs/api/class-electron (launch, firstWindow)
- https://playwright.dev/docs/test-webserver
- https://github.com/microsoft/playwright/issues/16621 (why flags go through main-process
  appendSwitch)
- PLAN §10 (hermeticity split — smoke suites have no `@realtime` tags)
