# Changelog

All notable changes to Tavern are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

## [0.5.0] — 2026-07-12

### Added

- **Voice quality stack.** Voice defaults now match what a Discord user expects:
  noise suppression defaults to DeepFilterNet3 (falling back to RNNoise
  automatically if its assets can't load, and to a raw mic only when both
  fail), the microphone publishes Opus at 64 kbps (up from the browser's
  ~32 kbps default), capture is 48 kHz mono in every mode, automatic gain
  control is off everywhere (no more level pumping between words), and echo
  cancellation stays always-on. There is no hard noise gate; all processing
  runs client-side in the audio worklet.

- **Stream audio on Linux — web and desktop.** Screen shares on Linux were
  always silent: Chrome only offers audio for tab shares there, and Chromium
  never lists PulseAudio monitors as capturable inputs. Shares that resolve
  without audio now fall back to capturing a system-audio (monitor) source
  directly — on the desktop app Tavern creates one automatically around each
  share (a pactl remap of the default output, works on PulseAudio and
  PipeWire); on the web it picks a monitor-labeled or user-chosen input
  (Settings → Voice → "Stream audio"). Echo-loopback is filtered: the capture
  runs through the browser's echo canceller, which removes Tavern's own voices
  and soundboard from the stream while game/app audio passes through
  (measured −54 dB self-audio vs untouched external audio on a real Linux
  audio stack). Tab shares keep their native tab audio; a share that wanted
  sound but got none now explains where to get it.

- **Lossless stream audio on Linux desktops with PipeWire.** Where PipeWire is
  running, the desktop app now captures stream audio through a native virtual
  mic (venmic) that excludes Tavern's own audio at the source — your friends'
  voices never enter the stream, and unlike the echo-canceller approach the
  game/music signal is untouched (no ducking while people talk). Systems
  without PipeWire (or if anything about the native path fails) silently keep
  the monitor-capture fallback above.

### Fixed

- **Chat messages never raised a notification.** Nobody got notified of new
  messages, on any platform. On the web the notify toggles default to on, but
  the browser permission was only ever requested when you *flipped* a toggle —
  so a fresh account never triggered the request and every `show()` silently
  no-oped. The app now asks for notification permission on its own whenever
  notifications are enabled and the browser hasn't been asked yet (immediately
  where the browser allows it, otherwise on your first click/keypress); a denied
  user is never re-prompted, and a dismissed prompt is re-offered on your next
  interaction instead of going silent for the session. Notifications also stopped
  working after logging out and back in without a full reload (the listeners
  stayed bound to the old, closed connections) — they're now rebuilt on each
  login. Separately, boot ignored the notification prefs returned by `/api/me`,
  so a setting you'd turned off elsewhere quietly reverted to on after a reload;
  those prefs are now hydrated at boot. A direct @mention now notifies whenever
  *either* "all messages" or "mentions" is on (previously "all messages" on but
  "mentions" off would notify for ordinary messages yet drop the one that named
  you). Notifications still fire only for other people's messages and only when
  the message isn't already on-screen (window unfocused, or a different server
  open). Desktop notifications also now no-op cleanly on a Linux box with no
  notification daemon instead of throwing.

- **Voice members could stop hearing each other.** In calls with 3+ people,
  some pairs would silently lose audio one way (A hears B, C doesn't) —
  especially after someone joined slowly, reconnected, or their machine slept.
  Four root causes fixed: per-track SFU pull rejections were silently
  swallowed (now retried until they succeed), the mic-pull retry gave up after
  5 seconds while a slow joiner's mic can take longer (now backs off for up to
  ~2 minutes and the server re-announces every mic registration), a member who
  re-published their mic after a reconnect was invisible to existing listeners
  (peers now re-pull via a per-member mic sequence number), and a dead
  connection kept showing "joined" while transmitting nothing (the client now
  detects the failure and rejoins automatically, keeping your mute/deafen
  state). Regression-tested with four concurrent clients asserting every pair
  hears every pair.

- **Streams now play at full quality everywhere.** Watched streams used to pull
  the low simulcast layer unless the tile was focused or fullscreen — a stream
  watched in the grid looked soft until you pressed `f`. Every watch now pins
  the high layer from the initial pull; focus and fullscreen are pure layout
  changes.
- **Linux login no longer fails without an OS keyring.** On systems with no
  Secret Service / kwallet (bare window managers, minimal distros — common for
  AppImage users), storing the session token threw "Encryption is not
  available." and the app showed *Connection failed* at login. Tavern now falls
  back to Chromium's basic obfuscated storage (the same scheme Chrome uses on
  such systems), and if even that is unusable (a detected but dead keyring
  daemon) the session is kept in memory for the run instead of failing login.

## [0.4.0] — 2026-07-12

### Added

- **Recording player**: recordings now play in a proper in-app player
  (play/pause, seek bar, elapsed/total time) instead of a bare browser element.
  The media route serves HTTP byte ranges + conditional GETs — recorded WebM
  carries no duration header, so seeking (and the duration display itself)
  needs a working range read; the desktop app fetches via an authed blob
  because a plain `<audio src>` cannot send the Bearer token.
- **macOS screen-recording permission hint**: when Tavern lacks the Screen
  Recording permission (the OS silently returns an empty source list), the
  share picker explains why and deep-links System Settings → Privacy &
  Security → Screen Recording.
- **Random name colors**: new accounts get a random non-gray palette color
  instead of the shared gray placeholder; the profile editor's swatches now
  offer exactly that shared palette (a free hex input still covers the rest).
- **Header avatar**: the user menu shows your uploaded avatar (colored initial
  stays as the fallback), and a fresh upload appears immediately — avatars are
  served with etag revalidation instead of a day-long cache.

### Fixed

- **Streams were a blurry mess for watchers.** Two compounding causes: the
  30/60 fps bitrate caps starved motion content (a 1080p60 share got 3000 kbps
  ≈ 0.02 bits/pixel — re-anchored to 6000; all 30/60 rows raised), and the
  SFU's automatic simulcast mode bounced fullscreen watchers back down to the
  270p layer on every bandwidth-estimate dip — watcher pulls now pin their
  chosen layer. Data tiers remain the cost knob.
- **Your own audio no longer echoes into your stream** (Windows 11+ and
  macOS): loopback capture now uses Chromium's process-exclusion device, so
  Tavern's voices/soundboard are subtracted from the shared system audio.
  Older Windows (builds below 20348) keeps full loopback and its one-time
  caveat toast; the toast is suppressed where exclusion is active.
- **Soundboard sounds now play for every in-voice member.** The `sound.played`
  broadcast is self-contained (carries the trim window) and playback moved to
  the voice controller — previously only members with the soundboard panel
  open actually heard anything.
- **Streams started before you connected are now visible**: the hello snapshot
  reads active streams from the RTC registry, so a client joining mid-share
  sees the tile instead of an empty canvas.
- **No more frozen "zombie" watches after a reconnect**: a room resnapshot
  revokes pull grants server-side, so live watches now reset to the Watch
  button instead of sitting on a dead pull with frozen video.

## [0.3.0] — 2026-07-11

### Added

- **Download landing page** at `/product`: one-screen page with a
  platform-detected download button (macOS/Windows/Linux), direct links to the
  latest release installers via the GitHub releases API (falls back to the
  releases page), and an "Open Tavern in your browser" entry point.

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
