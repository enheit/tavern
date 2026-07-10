# S12.2 — Auto-update + release pipeline

- after: S12.1
- unlocks: S12.3, S12.4
- FRs: FR-44
- references: PLAN §0 (R7 secrets), §3.2, §3.7 (mac-signing fallback), §6.3 (updates IPC), §11

## Goal

Tagged releases build on 3 OSes, publish to GitHub Releases, and running apps self-update: check
on launch + every 6h, download in background, show a "Restart to update" pill, restart applies.

## Preconditions (run these; red = STOP)

- `grep -q "^## S12.1" docs/progress.md` → exit 0
- `gh api repos/{owner}/{repo} -q .permissions.push` → `true` (push ⇒ `contents: write`)
- GitHub repo secrets exist: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER` (`gh secret list`). **Absent → execute PLAN §3.7 mac fallback (below), file
  the blocker, and continue — do not halt this step.**
- All secrets present in Bitwarden under the `tavern` folder (R7); anything missing → store it now.

## Tasks

1. `desktop/src/main/updates.ts` — implement the pinned behavior:
   - Init condition (all must hold, else module is inert):
     `app.isPackaged`
     AND (`process.platform !== 'linux'` OR `process.env.APPIMAGE` is set)   ← AppImage guard (PLAN §11)
     AND NOT (`process.platform === 'darwin'` AND `__MAC_UPDATES_DISABLED__`).
   - `__MAC_UPDATES_DISABLED__` is a build-time constant injected in `electron.vite.config.ts`
     main `define`: `JSON.stringify(process.env.TAVERN_MAC_UPDATES_DISABLED === '1')`.
   - `autoUpdater.checkForUpdatesAndNotify` is NOT used; pinned flow:
     `autoUpdater.checkForUpdates()` on `app.whenReady` and on a 6h `setInterval`;
     on `update-downloaded` → `mainWindow.webContents.send('update://ready', { version })`;
     IPC `updates.restartToUpdate` → `autoUpdater.quitAndInstall()`.
   - Errors: `autoUpdater.on('error')` → log via console.error only (no UI; next interval retries).
2. Renderer: `app/src/features/shell/UpdatePill.tsx` — pill in the header, visible after
   `platform.updates.onUpdateReady({ version })` fires; label i18n key
   `shell_update_pill_label` rendered as `m.shell_update_pill_label({ version })` (en:
   "Restart to update ({version})", uk: "Перезапустити для оновлення ({version})"); click →
   `updates.restartToUpdate()`. Verify the channel/method names match `shared/src/ipc.ts`
   exactly (S0.2, canonical) — mismatch → STOP.
3. `scripts/release.mjs` — pinned release script (semver taken from argv, no auto-bump logic):
   `node scripts/release.mjs 0.1.1` → writes `version` into root and `desktop/package.json`,
   `git commit -m "chore(release): v0.1.1"`, `git tag v0.1.1`, `git push --follow-tags`.
4. `.github/workflows/release.yml` — pinned structure:

```yaml
name: release
on: { push: { tags: ['v*'] } }
permissions: { contents: write }
jobs:
  build:
    strategy: { matrix: { os: [macos-latest, windows-latest, ubuntu-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -F @tavern/shared build && pnpm -F @tavern/app build && pnpm -F @tavern/desktop build
      - run: cd desktop && npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS signing + notarization — SCOPED to the mac runner. CSC_LINK/CSC_KEY_PASSWORD
          # are also electron-builder's *Windows* signing vars, so exposing the Apple .p12 on
          # windows-latest would try to sign the NSIS build with it (fails / mis-signs).
          # PLAN §11: Windows is unsigned in v1.
          CSC_LINK: ${{ runner.os == 'macOS' && secrets.CSC_LINK || '' }}
          CSC_KEY_PASSWORD: ${{ runner.os == 'macOS' && secrets.CSC_KEY_PASSWORD || '' }}
          APPLE_API_KEY: ${{ runner.os == 'macOS' && secrets.APPLE_API_KEY || '' }}
          APPLE_API_KEY_ID: ${{ runner.os == 'macOS' && secrets.APPLE_API_KEY_ID || '' }}
          APPLE_API_ISSUER: ${{ runner.os == 'macOS' && secrets.APPLE_API_ISSUER || '' }}
  publish:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: gh release edit "$GITHUB_REF_NAME" --draft=false
        env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }   # quoted — bare ${{ }} is invalid YAML inside a flow mapping
```
   (electron-builder uploads all artifacts + `latest*.yml` to a DRAFT release; the `publish` job
   flips it live — updaters cannot see drafts, so this job is load-bearing. PLAN §11.)
5. Worker deploy — separate file `.github/workflows/deploy.yml`, pinned YAML:

```yaml
name: deploy
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
    branches: [main]
permissions: { contents: read }
jobs:
  deploy:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # the worker serves ../app/dist as static assets — deploying without a fresh build
      # fails (missing assets dir) or ships a stale web client
      - run: pnpm -F @tavern/shared build && pnpm -F @tavern/app build
      - name: Account guard (NEVER Icelook — PLAN §11)
        run: cd worker && npx wrangler whoami | grep -q fd8a5f7a38f28a2cd11e79e85985c7d4
        env: { CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" }   # quoted — see release.yml note
      - name: D1 migrations (remote — schema lands before code that expects it)
        run: cd worker && npx wrangler d1 migrations apply tavern-db --remote
        env: { CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" }
      - run: cd worker && npx wrangler deploy
        env: { CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" }
```
   The guard step fails the job (and blocks deploy) if wrangler resolves any account other
   than Roman's personal `fd8a5f7a38f28a2cd11e79e85985c7d4` (belt; `account_id` in
   `wrangler.jsonc` is the suspenders). Migrations run BEFORE `wrangler deploy` so new code
   never meets an old schema; `wrangler d1 migrations apply` is idempotent (only unapplied
   files run), so a re-triggered workflow is safe.
   **Steady state this file creates (the product's operating loop): commit to main → ci.yml
   (all gates + 3-OS package-check) → deploy.yml (migrations + web deploy). Zero human steps.**
   If the `CLOUDFLARE_API_TOKEN` repo secret does not exist yet, create it in this task: mint an
   API token on the personal account (dash.cloudflare.com/profile/api-tokens or the CF API)
   scoped to `Workers Scripts:Edit` + `D1:Edit` + `Account Settings:Read`, then
   `gh secret set CLOUDFLARE_API_TOKEN` and store it in Bitwarden under the `tavern` folder (R7).
6. **Mac-signing fallback (only if preconditions found secrets absent, PLAN §3.7):** mac matrix
   step runs with `CSC_IDENTITY_AUTO_DISCOVERY: false`, `TAVERN_MAC_UPDATES_DISABLED: '1'`, and
   `--config.mac.notarize=false` appended to the electron-builder command; file the blocker
   documenting that macOS auto-update is OFF until certs exist.
7. `.github/workflows/nightly.yml` — CREATE it here (S12.3 later appends its `soak` job). It is
   never part of PR CI. Pinned structure:

```yaml
name: nightly
on:
  schedule: [{ cron: '0 3 * * *' }]
  workflow_dispatch: {}          # required so `gh workflow run nightly.yml` (S12.4) works
permissions: { contents: read }
jobs:
  realtime-e2e:                  # @realtime media suites against the REAL Cloudflare Realtime SFU
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm e2e:realtime    # web-realtime project (S7.4), real SFU, against wrangler dev
        env:
          REALTIME_APP_ID: ${{ secrets.REALTIME_APP_ID }}
          REALTIME_APP_SECRET: ${{ secrets.REALTIME_APP_SECRET }}
          TURN_KEY_ID: ${{ secrets.TURN_KEY_ID }}
          TURN_KEY_API_TOKEN: ${{ secrets.TURN_KEY_API_TOKEN }}
  boot-smoke:                    # packaged-app launch on all 3 OSes
    strategy: { matrix: { os: [macos-latest, windows-latest, ubuntu-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -F @tavern/shared build && pnpm -F @tavern/app build && pnpm -F @tavern/desktop build
      - run: cd desktop && pnpm exec electron-builder --dir
      # launch the unpacked binary (S12.1's per-OS path table via TAVERN_DESKTOP_BINARY),
      # assert window title `Tavern`, quit:
      - run: pnpm -F @tavern/e2e test --project=desktop --grep smoke
  # AppImage-boot container jobs — the AppImage must launch where CI's ubuntu-latest can't prove it:
  appimage-void:                 # Void Linux (static AppImage runtime, no FUSE2 — PLAN §3.2)
    runs-on: ubuntu-latest
    container: ghcr.io/void-linux/void-glibc-full:latest
    steps:                       # checkout+install+build → electron-builder --dir → run the
                                 # AppImage under xvfb → assert window title `Tavern` → quit
  appimage-ubuntu2404:           # Ubuntu 24.04 (apparmor_restrict_unprivileged_userns=1 breaks
    runs-on: ubuntu-latest       # Chromium's sandbox for AppImages — PLAN §11; boot smoke catches it)
    container: ubuntu:24.04
    steps:                       # same shape as appimage-void
```
8. FR-44 live verification (the only honest test of an updater): release `v0.1.0`, install the
   artifact for your current OS (Linux: run the AppImage itself — the guard requires it), then
   release `v0.1.1` and leave the app running.

## Pinned interfaces & artifacts

Files created: `desktop/src/main/updates.ts`, `app/src/features/shell/UpdatePill.tsx`,
`scripts/release.mjs`, `.github/workflows/release.yml`, `.github/workflows/deploy.yml`,
`.github/workflows/nightly.yml`, `desktop/test/updates.test.ts`,
`app/src/features/shell/UpdatePill.test.tsx`.
Files modified: `desktop/electron.vite.config.ts` (main `define`), root `package.json` +
`desktop/package.json` (version writes by release.mjs), `app/src/features/shell/Header.tsx`
(mount the pill — S5.2 owns the header), `app/messages/en.json`, `app/messages/uk.json`.

- IPC contract (canonical — S0.2 owns `shared/src/ipc.ts`; S4.1's main-process send must match):
  `updates.onUpdateReady(cb: (info: { version: string }) => void)`,
  `updates.restartToUpdate(): Promise<void>`; event channel string `update://ready` (PLAN §6.3).
- New i18n key: `shell_update_pill_label` (en+uk, parity test will fail if one is missing).
- Secrets ledger after this step (GitHub Actions + Bitwarden, both): `CLOUDFLARE_API_TOKEN`,
  `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`,
  `REALTIME_APP_ID`, `REALTIME_APP_SECRET`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` (last four exist
  since S7.1 — verify presence, don't recreate).

## Tests

- `desktop/test/updates.test.ts` — `describe('FR-44 auto-update gating')`: init is inert when
  `!app.isPackaged`; inert on linux without `APPIMAGE`; inert on darwin with
  `__MAC_UPDATES_DISABLED__`; `update-downloaded` forwards `{version}` on `update://ready`;
  `restartToUpdate` calls `quitAndInstall` (electron + electron-updater mocked).
- `app/src/features/shell/UpdatePill.test.tsx` — `describe('FR-44 update pill')`: hidden by
  default; renders version after onUpdateReady; click invokes restartToUpdate.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/desktop test` and `pnpm -F @tavern/app test` → green incl. the two suites above
- [ ] `pnpm typecheck && pnpm lint && pnpm check:i18n` → exit 0
- [ ] `node scripts/release.mjs 0.1.0 && sleep 30 && gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId') --exit-status` → release workflow green
- [ ] `gh release view v0.1.0 --json assets -q '.assets[].name'` → contains an artifact for all 3 OSes AND `latest.yml` AND `latest-mac.yml` AND `latest-linux.yml` (mac yml absent only under the §3.7 fallback — note it)
- [ ] Live update check (FR-44 AC): with installed v0.1.0 running, `node scripts/release.mjs 0.1.1`; after the v0.1.1 release workflow completes, relaunch the app → the `app.whenReady` check downloads the update → the pill appears → click → app restarts → version is 0.1.1. Screenshot pair (pill, post-restart about/version) pasted into progress.md.

## STOP conditions (beyond global R1)

- `latest-mac.yml` missing while mac secrets ARE configured → blocker (zip target or notarize broke; do not ship mac).
- Any impulse to store a secret in the repo or a workflow file → R7 violation, stop.
- Updater errors mentioning signature/publisherName on Windows → record verbatim in blocker (unsigned-Windows consequence is accepted, but errors must be documented, not silenced).

## Docs (consult only these)

- https://www.electron.build/docs/features/auto-update/
- https://www.electron.build/docs/features/github-actions/
- https://cli.github.com/manual/gh_release_edit
