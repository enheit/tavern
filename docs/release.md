# Releasing Tavern (S6.3)

## Update signing

Updater artifacts are minisign-signed. The keypair was generated with
`pnpm tauri signer generate -w ~/.tauri/tavern.key --ci` (no password):

- **Private key `~/.tauri/tavern.key` — NEVER committed.** It also lives in the GitHub
  Actions secret `TAURI_SIGNING_PRIVATE_KEY` (the bundle job signs with it;
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is empty).
- Public key: embedded in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- Losing the private key orphans every installed app (updates stop verifying) —
  a replacement key requires a manual reinstall.

Local signed build:

```sh
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/tavern.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build
```

With `createUpdaterArtifacts: true` the bundler emits, per platform, the update
bundle (macOS `Tavern.app.tar.gz`, Windows the NSIS `*-setup.exe`, Linux the
`.AppImage`) plus a matching `.sig` file whose contents go into the manifest's
`signature` field.

## Publishing an update

1. Bump `version` in `src-tauri/tauri.conf.json` (all three of conf/Cargo stay in sync
   via tauri.conf.json being the source the bundler stamps).
2. Build signed bundles per platform (CI `bundle` job artifacts, or locally as above).
3. Upload the update bundles to R2 `tavern-updates` (personal account):
   `npx wrangler r2 object put tavern-updates/<file> --file <path> --remote`
4. Generate + validate the manifest (schema-pinned; refuses malformed input):

   ```sh
   node worker/scripts/gen-update-manifest.ts \
     --version 0.2.0 --notes "what changed" \
     --base https://tavern.roman-mahotskyi.workers.dev \
     --artifact darwin-aarch64:Tavern.app.tar.gz:Tavern.app.tar.gz.sig \
     -o latest.json
   ```

5. `npx wrangler r2 object put tavern-updates/latest.json --file latest.json --remote`

Clients check `https://tavern.roman-mahotskyi.workers.dev/updates/latest.json`
(Worker route → R2, 60 s cache) silently at boot, download + install in the
background, and apply on the next launch.

## macOS signing & notarization

CI/local builds are ad-hoc signed (no Apple Developer account wired). The bundle
carries the hardened-runtime entitlements (`src-tauri/entitlements.plist`: camera +
audio-input) and the TCC usage strings (`src-tauri/Info.plist`); verify with:

```sh
codesign -d --entitlements :- "src-tauri/target/release/bundle/macos/Tavern.app"
```

For distribution outside this machine:

1. Join the Apple Developer Program; create a "Developer ID Application" certificate.
2. `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_SIGNING_IDENTITY` env for
   `tauri build` (bundler signs with the identity + the same entitlements).
3. Notarize: `APPLE_ID`/`APPLE_PASSWORD` (app-specific) /`APPLE_TEAM_ID` env — the
   bundler submits and staples automatically.
4. `minimumSystemVersion` is pinned to 13.3 (WebCodecs floor, §1) — do not lower.

## Windows / Linux

- Windows: NSIS installer (`*-setup.exe`); unsigned (SmartScreen warning expected —
  acceptable for a friends-only app).
- Linux: AppImage + .deb. AppImage is the updater-capable target.
