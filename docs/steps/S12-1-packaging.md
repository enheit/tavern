# S12.1 — Packaging (electron-builder config, icons, entitlements)

- after: S8.5
- unlocks: S12.2
- FRs: — (packaging substrate for FR-44; ships every desktop FR)
- references: PLAN §3.2, §3.6 (traps 3, 9), §3.7, §4, §10 (nodeCliInspect rule), §11

## Goal

Produce installable desktop artifacts on all three OSes with one pinned electron-builder config:
NSIS (Windows), DMG+ZIP (macOS, hardened runtime, notarize-ready), AppImage (Linux, static
runtime). The packaged app loads the same `@tavern/app` build the web target serves.

## Preconditions (run these; red = STOP)

- `grep -q '^## S8.5' docs/progress.md` → exit 0 (streams e2e done)
- `pnpm -F @tavern/app build && test -f app/dist/index.html` → exit 0
- `pnpm -F @tavern/desktop build && test -f desktop/out/main/index.js` → exit 0
- `magick -version` → prints ImageMagick (install: macOS `brew install imagemagick`,
  Linux `sudo apt-get install -y imagemagick`; if only the ImageMagick-6 `convert`
  binary exists, substitute `convert` for `magick` in Task 2 with identical arguments)

## Tasks

1. Install electron-builder as an exact dev dependency:
   `pnpm -F @tavern/desktop add -DE electron-builder@^26.0.0` (§3.2 pins ^26.0.0 →
   26.15.6; the `latest`/`next` dist-tags are forbidden — never bare `npx electron-builder`).
2. Set `repository` in the root and `desktop/package.json` to the URL printed by
   `git remote get-url origin` (electron-builder infers the GitHub owner/repo from it).
3. Create `desktop/build/icon.png` (1024×1024 placeholder — replaceable later, path stays):
   `magick -size 1024x1024 xc:'#6b4a2f' -fill white -pointsize 640 -gravity center -annotate 0 'T' desktop/build/icon.png`
   electron-builder derives `.icns`/`.ico` from it automatically.
4. Create `desktop/build/entitlements.mac.plist` with exactly the four entitlements pinned below.
5. Create `desktop/electron-builder.yml` with exactly the pinned content below.
6. Set `"version": "0.1.0"` in `desktop/package.json` if absent (verbatim value — no
   ancestor sets it and electron-builder refuses to build without one), and verify
   `"main": "out/main/index.js"` is present. The S12.2 release script becomes the only
   thing that changes `version` thereafter.
7. Build unpacked for the current OS and verify boot + asar layout (DoD).
8. APPEND the `package-check` job to `.github/workflows/ci.yml` (PLAN §11 + S0.3 structural pin:
   every push to `main` proves all 3 desktop platforms still package; skipped on PRs and
   feat/electron; `deploy.yml` — S12.2 — waits on this workflow's conclusion):

   ```yaml
     package-check:
       if: github.event_name == 'push' && github.ref == 'refs/heads/main'
       strategy:
         fail-fast: false
         matrix: { os: [macos-latest, windows-latest, ubuntu-latest] }
       runs-on: ${{ matrix.os }}
       steps:
         - uses: actions/checkout@v4
         - uses: pnpm/action-setup@v4
         - uses: actions/setup-node@v4
           with: { node-version: 22, cache: pnpm }
         - run: pnpm install --frozen-lockfile
         - run: pnpm -F @tavern/shared build && pnpm -F @tavern/app build && pnpm -F @tavern/desktop build
         # Unsigned packaging proof: full installer targets, no publish, no notarization
         # (release.yml owns signing; CSC auto-discovery off so the mac runner can't grab a
         # random keychain cert).
         - run: cd desktop && pnpm exec electron-builder --publish never --config.mac.notarize=false
           env:
             CSC_IDENTITY_AUTO_DISCOVERY: 'false'
   ```

## Pinned interfaces & artifacts

Files created: `desktop/electron-builder.yml`, `desktop/build/icon.png`,
`desktop/build/entitlements.mac.plist`.
Files modified: root `package.json` + `desktop/package.json` (repository field, version),
`.github/workflows/ci.yml` (task 8 — the `package-check` job APPEND only; existing jobs untouched).

**Renderer packaging contract (pinned pair — S4.1 depends on it):** electron-builder copies
`../app/dist` into the asar at `renderer/`; the main process `app://` protocol handler resolves
files from `path.join(app.getAppPath(), 'renderer')`. If S4.1's handler reads any other path, that
is a plan bug → STOP (do not adapt silently).

`desktop/electron-builder.yml` (complete file):

```yaml
appId: com.tavern.app
productName: Tavern
directories:
  output: dist-electron
  buildResources: build
files:
  - out/**
  - from: ../app/dist
    to: renderer
# Fuses: deliberately NOT configured in v1 — Electron defaults keep the nodeCliInspect fuse ON,
# which Playwright _electron.launch requires (PLAN §10). Flipping fuses needs a blocker first.
mac:
  target: [dmg, zip]          # zip is what Squirrel.Mac updates from — never remove (PLAN §11)
  hardenedRuntime: true
  notarize: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  extendInfo:
    NSMicrophoneUsageDescription: "Tavern needs your microphone for voice chat."
    NSCameraUsageDescription: "Tavern needs your camera to share your webcam."
    NSAudioCaptureUsageDescription: "Tavern captures system audio when you share your screen with sound."
win:
  target: nsis
nsis:
  oneClick: true
  perMachine: false
linux:
  target: AppImage
  category: Network
  toolsets:
    appimage: "1.0.3"         # static runtime, no FUSE2 — required for Void/Ubuntu 24.04+ (PLAN §3.2)
publish:
  provider: github
  # owner/repo inferred from package.json "repository"; releases are created as DRAFTS
  # (electron-builder default) — S12.2's pipeline publishes the draft.
```

`desktop/build/entitlements.mac.plist` (complete file — the standard Electron hardened-runtime
set plus the two device grants this app needs):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
    <key>com.apple.security.device.audio-input</key><true/>
    <key>com.apple.security.device.camera</key><true/>
  </dict>
</plist>
```

Unpacked-binary paths per OS (used by DoD and by Playwright packaged-app runs):

| OS | binary |
|---|---|
| macOS arm64 | `desktop/dist-electron/mac-arm64/Tavern.app/Contents/MacOS/Tavern` |
| Linux x64 | `desktop/dist-electron/linux-unpacked/tavern` |
| Windows x64 | `desktop/dist-electron/win-unpacked/Tavern.exe` |

## Tests

No new unit tests (config-only step). Verification is the DoD below plus one e2e re-run against
the packaged binary:

- `e2e/desktop/smoke.spec.ts` — existing S4.4 smoke, executed with
  `TAVERN_DESKTOP_BINARY=<unpacked binary path>` so `_electron.launch({ executablePath })` drives
  the PACKAGED app (harness already switches on that env var; if it doesn't → STOP, S4.4 gap).

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/shared build && pnpm -F @tavern/app build && pnpm -F @tavern/desktop build` → exit 0
- [ ] `cd desktop && pnpm exec electron-builder --dir` → exit 0
- [ ] asar layout (run the line for your OS; paste the matched line into progress.md):
  - macOS: `npx @electron/asar@4.0.1 list 'desktop/dist-electron/mac-arm64/Tavern.app/Contents/Resources/app.asar' | grep -q '^/renderer/index.html'` → exit 0
  - Linux: `npx @electron/asar@4.0.1 list desktop/dist-electron/linux-unpacked/resources/app.asar | grep -q '^/renderer/index.html'` → exit 0
  - Windows: `npx @electron/asar@4.0.1 list desktop/dist-electron/win-unpacked/resources/app.asar | grep -q '^/renderer/index.html'` → exit 0
- [ ] Launch the unpacked binary manually → window opens, title `Tavern`, login screen renders (screenshot in progress.md — visual evidence per repo rule)
- [ ] `TAVERN_DESKTOP_BINARY=<binary> pnpm -F @tavern/e2e test --project=desktop --grep smoke` → green
- [ ] `git push && sleep 10 && gh run watch "$(gh run list --branch feat/electron --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status` → ci green (the new `package-check` job shows as **skipped** — it only runs on pushes to main; its 3-OS proof comes when v1 merges)

## STOP conditions (beyond global R1)

- S4.1's protocol handler does not read `path.join(app.getAppPath(), 'renderer')` → blocker (contract mismatch).
- electron-builder demands signing config just to produce `--dir` output on your OS → blocker (should not happen; do not add certs here — signing is S12.2).
- Any temptation to configure `electronFuses` → blocker first (PLAN §10 nodeCliInspect rule).

## Docs (consult only these)

- https://www.electron.build/ (configuration reference)
- https://www.electron.build/docs/appimage/ (static runtime toolset)
- https://www.electron.build/code-signing (mac entitlements/hardened runtime background — read-only here)
