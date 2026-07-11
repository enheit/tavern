# Changelog

All notable changes to Tavern are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.2.1] — 2026-07-11

### Fixed

- **Desktop release builds could never reach the server** ("Couldn't connect
  to the server." on boot). The packaged renderer is served from the
  `app://tavern` scheme, so relative API URLs resolved against the static-file
  handler instead of the Worker. Release builds now bake the production Worker
  origin in at build time (`VITE_API_URL`), and the Worker answers CORS for
  the `app://tavern` origin (Authorization header allowed, `set-auth-token`
  exposed for the desktop bearer flow). Affected every desktop artifact since
  v0.1.0; the worker-served web client was never affected.

## [0.2.0] — 2026-07-11

### Added

- **Noise suppression, 4 modes** (Settings → Voice): Off (AEC only), Standard
  (browser NS+AGC), RNNoise (WASM worklet, ~150 KB) and DeepFilterNet3 (WASM,
  ~24 MB self-hosted assets, lazy-loaded). The old boolean setting migrates
  silently; any worklet load failure fails open to the raw mic.
- **GIF picker in chat**: Discord-style picker backed by Klipy through a Worker
  proxy (`/api/gifs/search`); serves a mock set when `KLIPY_API_KEY` is unset.
- **Stream screenshots**: press Space on a focused stream to capture a frame to
  R2; new Screenshots tab per server plus a public capability view URL.
- **Data-tier share control**: 48 tiered presets (100/75/50/35 % data budgets),
  a quality group in the controls bar, `cost.update` broadcasts and an egress
  meter in the Stats tab.
- **Voice auto-resume on refresh**: a per-tab session snapshot rejoins the voice
  channel after F5 and replays mute/deafen/webcam state; explicit leave and
  logout clear it. Screen share is deliberately not resumed (needs a gesture).
- **Activity indicators**: REC dot driven by the recording timer, screen-share /
  webcam / watching icons on member chips, new `watch.state` broadcast.
- **Voice panel rework**: dedicated VoicePanel, split share button, member-chip
  icon row; People tab reorganised.
- **Theater mode**: per-tile maximize button expands a stream to a fullscreen
  overlay; Esc exits (with priority over focus mode), pulls survive reparent.
- **Header status**: shared per-user status with inline editing, round-tripped
  through the server room.
- **One-time server-creation codes**: creating a server now requires a seeded
  code; /join redesigned as a single card and server passwords are mandatory.
- **Boot error screen**: boot no longer hangs forever — a 15 s deadline shows
  "Couldn't connect to the server." with a working Retry.
- Readable login/register error messages; auth routes redirect when already
  signed in. Password fields gained show/hide toggles.
- Brand icon: rounded macOS app icon + favicon.
- New UI primitives: button group, spinner.

### Fixed

- **Boot self-heal**: `/api/ws-ticket` now ships the D1 truth and the server
  room seeds missing state from it (fill-only — never overwrites a live cache),
  so a wiped room cache can no longer strand login on the boot loader; an
  uncaught room-handler failure now closes the socket (1011) instead of
  leaving it hanging.
- Autoplay-blocked rejoin: joining without a user gesture no longer hangs on
  `AudioContext.resume()` — the join proceeds and audio unblocks on the first
  interaction.
- Auth/join pages are vertically centered again.
- Soundboard playCount test deflake.

### Changed

- Chat/soundboard UI tweaks; CSP allows `wasm-unsafe-eval` + `blob:` workers
  for the noise-suppression worklets.

### Notes

- The WS protocol gained frames (`watch.state`, `cost.update`, status).
  Deploy worker + web app together; older clients crash on unknown frames.

## [0.1.1] — 2026-07-11

### Fixed

- FR-27 stream resolution is encoder-owned (`scaleResolutionDownBy`) — fixes
  presets silently not applying on some platforms.
- Worker absorbs transient SFU 5xx with a bounded retry; `RealtimeError` maps
  to a typed 502.
- Voice join no longer dies on the mic race; realtime e2e asserts decoded
  audio.
- Packaging: Linux `executableName` pinned to `tavern`; release script
  preflights existing tags and re-runs idempotently.
- Nightly: WebRTC egress probe, AppImage boot fixes, deflaked realtime specs.

## [0.1.0] — 2026-07-09

First Electron release (full rewrite from the abandoned Tauri tree).

- Auth (register/login), servers (create/join/switch), admin ops
  (rename/password/kick).
- Chat with emoji, mentions, history and notifications.
- Voice channels: join/leave, device selection, per-user volumes, speaking
  indicators, mute/deafen, session timer.
- Screen share + webcam publish with simulcast presets, watch/unwatch, canvas
  auto-layout, focus mode, per-stream volume, loopback audio.
- Soundboard (upload, trim, play stats), voice recording to the server,
  activity log, per-user stats tab.
- Web client at parity, served by the Worker; desktop auto-update
  (unsigned macOS for v1); CI + nightly + deploy pipelines.
