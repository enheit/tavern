# Tavern — Implementation Plan (Electron rewrite, v1.0)

> **Source of truth for the entire build.** Implementer agents execute this plan verbatim.
> Product requirements come from `task.md` + `images/` (layout screenshots). This plan supersedes
> everything on `main` (the abandoned Tauri implementation — never read it, never reference it).

---

## §0 — How to execute this plan (READ FIRST, every agent, every step)

This plan is executed by a fleet of implementer agents. **You (the implementer) make zero design
decisions.** Every technology, version, file path, interface, constant, and acceptance gate is
pinned here or in your step file. Your job is transcription of spec into code, plus tests.

### 0.1 Reading order for an implementer assigned step SX.Y

1. This section (§0) and §9 (code quality & conventions) — in full.
2. `docs/steps/SX-Y-*.md` — your step file, in full.
3. Every §-section and appendix your step file references.
4. `docs/progress.md` — entries of the steps your step depends on.

Do **not** read other step files, `main` branch code, or `task.md` (already normalized into §1).

### 0.2 Hard rules

- **R1 — No new decisions.** If anything is ambiguous, underspecified, or contradicts observed
  reality (a doc, an API, a failing install): **STOP**. Append an entry to `docs/blockers.md`
  (template in §0.4) and end your run. Do not improvise, do not pick "the reasonable option".
- **R2 — Exact versions.** Install exactly the versions pinned in §3 (`pnpm add -E`). If a pinned
  version is unavailable → STOP (R1). Never bump, never add a dependency not listed in §3.
- **R3 — DoD is executable.** A step is done only when every Definition-of-Done command in the
  step file runs green, verbatim, from repo root. Copy real command output into `docs/progress.md`.
  Claims of success without command output are invalid (repo rule: results are proven only by
  tests or visual verification).
- **R4 — Never weaken gates.** Forbidden, always: skipping/`.skip`ing a failing test, deleting a
  test to pass, lowering a coverage threshold, `--no-verify`, loosening a zod schema to make data
  fit, `any`/`@ts-ignore`/`oxlint-disable` (see §9 for the two narrow exceptions).
- **R5 — Touch only your files.** Each step file lists the files it creates/modifies. Needing to
  touch anything else → STOP (R1). Generated files (lockfile, shadcn components, migrations) are
  exempt when the step says so.
- **R6 — Three-strikes.** If a DoD gate stays red after 3 genuinely different fix attempts,
  STOP and file a blocker with all three attempts documented.
- **R7 — Secrets.** Never commit secrets. Local: `worker/.dev.vars` (gitignored). Deployed:
  `wrangler secret put`. CI: GitHub Actions secrets. Every secret created or first seen must also
  be stored in the Bitwarden MCP under the `tavern` project folder (repo rule). Missing secret → STOP.
- **R8 — Commits.** One step = one commit on `feat/electron`:
  `feat(SX.Y): <step title>` with the `docs/progress.md` entry included in the same commit.
  Trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **R9 — Preconditions are verified, not assumed.** Each step file lists precondition commands
  (e.g. "`pnpm -F @tavern/shared test` green"). Run them first. Red precondition → STOP.
- **R10 — shadcn/Base UI components via MCP, never from memory.** Any step touching
  `components/ui/*` or writing markup against a shadcn-installed component (Dialog, Select,
  Popover, etc.) MUST query the shadcn MCP server (installed S4.2, §3.3) for that component's
  current source/attributes before writing or editing markup — never reconstruct Base UI markup
  from training-data memory of (older, Radix-based) shadcn examples. This is the primary defense
  against §3.6 trap 11 (Radix-flavored `[data-state=…]` leaking in instead of Base UI's
  `[data-open]`/`[data-starting-style]`). MCP unreachable → read the actual generated source in
  `src/components/ui/*` instead of memory; note the outage in the step's `docs/progress.md` entry.

### 0.3 `docs/progress.md` entry template

```md
## SX.Y — <title> — <ISO date>
- Agent: <model/session id>
- DoD results: <each command + trimmed real output (test counts, coverage %, exit codes)>
- Files created/modified: <list>
- Deviations: none            <- anything other than "none" requires a blocker entry instead
- Notes for dependents: <1-3 lines max, only if load-bearing>
```

### 0.4 `docs/blockers.md` entry template

```md
## BLOCKER — SX.Y — <ISO date>
- What the plan says: <quote §/step>
- What reality says: <observed doc/API/error, with URL or output>
- Attempts (if R6): <3 attempts>
- Smallest question a human must answer: <one sentence>
STATUS: OPEN
```

A step with an OPEN blocker is frozen. Other steps not depending on it may proceed.

### 0.5 Step dependency discipline

The dependency graph is in §12. A step may start only when all its `after:` steps have a green
`docs/progress.md` entry. Independent tracks (backend vs desktop-shell) may run in parallel.

---

## §1 — Product specification (normalized from task.md; task.md is now retired)

Tavern is a Discord-like desktop+web app for one small friend group: max **10 users per server**,
**~5 servers** total. Voice chat, screen sharing while gaming, text chat, soundboard. Performance
and correctness over visual flair. Product name: **Tavern**. Languages: English + Ukrainian.
Platforms: Windows 10/11, macOS (arm64+x64), Linux (Arch/Ubuntu/Void via AppImage), and a web
version served from the same backend.

Every FR below carries acceptance criteria (AC). The traceability matrix (§13) maps FR → steps →
tests. Test files reference FR ids in `describe()` strings so coverage is greppable (`FR-\d+`).

### 1.1 Accounts & profile

- **FR-01 Register** with `username` + `password` + `repeatPassword`. No email, no OAuth.
  AC: unique username (case-insensitive), rules in §App-B; mismatch/duplicate/too-short each show a
  specific inline error; success lands in the logged-in boot flow.
- **FR-02 Login** with username + password. AC: wrong credentials → generic error (no user
  enumeration); success restores session on next launch without re-login.
- **FR-03 Display name ≠ username.** Both exist. `username` = unique handle for login + @mentions;
  `displayName` = free-form UI name. User can change **both** (username change keeps identity —
  stable `userId`). AC: changes propagate live to all connected members (member.update).
- **FR-04 Nickname color.** User picks a hex color; used for their name in chat + member list.
  AC: validated `#rrggbb`; live-propagates.
- **FR-05 Avatar.** Upload image → shown in member list/chat. AC: client resizes to 256×256 webp
  before upload; worker validates type+size (§App-B); live-propagates.
- **FR-06 Theme** light/dark/system. AC: instant switch, persists across restart, "system" follows
  OS changes live.
- **FR-07 Language** en/uk. AC: every UI string translated (lint-enforced, §9.6); persists.

### 1.2 Servers & membership

- **FR-08 Create server**: unique server nickname + a required password (≥4), gated by a one-time,
  operator-issued **creation code**. Creator becomes **admin**. Server has a stable `serverId`
  forever. AC: appears in creator's server list; single voice channel + single text channel exist
  by default; the creation code is single-use and its use is audited (who used it, when, and which
  server it created) — a spent or unknown code → `invalid_code` (403).
- **FR-09 Join server** by nickname (+ password if set). Users can join many servers and switch
  between them (header dropdown). AC: wrong password → error; join rejected with `server_full`
  when the member count reached `LIMITS.maxMembersPerServer`; joined server persists across
  restarts; member list updates live for existing members.
- **FR-10 Admin: change server password.** AC: takes effect for the next join attempt; existing
  members unaffected.
- **FR-11 Admin: kick user.** AC: kicked user's sockets close with reason, their UI returns to the
  server-join screen, membership removed; they can rejoin (password required if set); activity log
  entry created.
- **FR-12 Admin: rename server.** Nickname stays unique; `serverId` stable. AC: all members see the
  new name live.
- **FR-13 Channel schema is multi-channel-ready** but v1 renders exactly one voice + one text
  channel. AC: D1 has a channels table AND the DO's `messages`/`voice_sessions` tables carry a
  `channel_id` column (v1 constant `'main'`) — adding channels later is a feature, not a data
  migration. UI hardcodes the two default channels.

### 1.3 Text chat

- **FR-14 Messages with emoji.** Unicode emoji render; picker inserts them. AC: send on Enter,
  ≤2000 chars, history persists and paginates (50/page, infinite scroll up).
- **FR-15 Mentions** `@username` with autocomplete; highlighted in messages. AC: server-side
  mention extraction (case-insensitive against current members) stored with the message.
- **FR-16 Notifications.** System notification on new message; two independent user settings:
  all-messages (default ON) and mentions (default ON). AC: no notification when window focused AND
  that server is active; clicking a notification focuses the app on that server; settings persist
  per account (work across devices).
- **FR-17 History** stored server-side (per-server DO SQLite), survives restarts.

### 1.4 Voice

- **FR-18 Join/leave voice** by clicking the voice channel in the left sidebar; leave via Controls
  bar. AC: join/leave reflected to all members <1s; user can be in voice on only one server at a
  time (joining a second prompts to confirm leaving the first).
- **FR-19 Voice transport**: mic published to the Cloudflare Realtime SFU; every voice member's
  audio auto-subscribed (voice is automatic; video is opt-in per FR-30). AC: two clients in voice
  hear each other (e2e via fake-media + `getStats` assertions on audioLevel/bytes).
  AMENDED (join latency, 2026-07-13) — the local audio graph starts with the join gesture, but the
  `voice.state` self-ack remains the authorization barrier before SFU requests and mic capture
  (so a lost ack cannot strand a live mic). After that ack, mic acquisition and the independent
  publishPC/voicePullPC start concurrently. The pull branch subscribes to and attaches existing
  remote mics without waiting for local mic permission, device startup, or noise-model loading;
  the publish branch publishes the mic independently. UI remains
  `joining` (with an explicit indicator) until both branches finish. A mic failure preserves the
  full-duplex contract by settling both branches, tearing down, and sending `voice.leave`.
  AMENDED (Task-1 audibility, 2026-07-12) — the auto-subscribe pipeline is self-healing, each
  piece load-bearing (removing any one re-opens an asymmetric-deafness class): (1) per-track SFU
  pull errors (200 + `tracks[].error`) THROW client-side (`PullTracksError`) after renegotiating
  the successful tracks — never silently swallowed; (2) the mic pull retries with capped
  exponential backoff (500 ms·2ⁿ, cap 5 s, ≈2.3 min) — a slow joiner's permission prompt / DFN
  fetch outlives any flat budget; (3) the DO broadcasts `voice.state` with a bumped
  `VoiceMember.micSeq` on every mic registration — peers re-pull on a seq change (rejoin/recovery
  re-registers `mic:{uid}` under a NEW SFU session invisibly otherwise); (4) a terminal transport
  failure (pc `connectionState 'failed'`) on either PC auto-recovers via full teardown + rejoin,
  preserving mute/deafen. Regression net: mock e2e "four concurrent joiners all hear each other
  pairwise" (graph-attach truth) + @realtime "every ordered pair's per-mic bytesReceived grows"
  (per-trackName inbound-rtp split via the §10 statsByTrack hook).
- **FR-20 Per-user local volume + mute.** Slider 0–200% and a mute toggle per remote user, local
  only, persisted locally. AC: gain applied via WebAudio per-user node; survives restart.
- **FR-21 Device selection**: input mic + output device pickers. AC: switching mid-call works
  without rejoin; persisted; output routing includes remote voice, streams, and soundboard.
- **FR-22 Noise suppression** ("voice cancellation" in task.md) — 4-mode enum
  `off / standard / rnnoise / deepfilter`. AMENDED (Task-2 voice-quality stack, 2026-07-12), the
  pinned matrix:
  **Default = `deepfilter`** (DeepFilterNet3 WASM worklet, self-hosted assets under
  `/deepfilternet`) with an AUTOMATIC runtime fallback chain `deepfilter → rnnoise → raw` when the
  DFN assets/wasm fail to load (the setting itself never rewrites; the chain re-tries DFN on the
  next acquisition). Legacy boolean records migrate `true → deepfilter`, `false → off`; invalid →
  `deepfilter`.
  `echoCancellation` is ALWAYS on (turning it off with speakers = feedback — Chromium WebRTC AEC).
  `autoGainControl` is ALWAYS off (AGC pumps speech levels between words; the suppressor's own
  leveling wins — Discord-parity choice). `noiseSuppression` (browser NS) only in `standard`; the
  WASM modes feed their model the unprocessed signal. Capture is **48 kHz mono** in every mode
  (Opus voice is mono 48 kHz; the models are mono 48 kHz). No hard noise gate anywhere. All
  processing is client-side in the AudioWorklet (§7.3 one-context rule).
  The published mic targets **Opus 64 kbps** (publishSession.publishMic: fmtp
  `maxaveragebitrate=64000` munged into the applied SFU answer + sender `maxBitrate` cap — either
  lever alone is engine-dependent).
  Mechanism (pinned — Chromium WontFix crbug 327472528 makes `applyConstraints` a no-op for
  these): stop the mic track, re-`getUserMedia` with the new constraints,
  `RTCRtpSender.replaceTrack` — the call never renegotiates. AC: toggle mid-call works without
  leaving voice.
- **FR-23 Speaking indicators.** Green ring on the speaking member (local analyser, threshold in
  §App-B). AC: visible for both remote and self.
- **FR-24 Voice session timer + auto-close.** Timer shows how long the voice session has been
  active (since first member joined). When the last member leaves, the session closes (activity
  entry); DO alarm also closes sessions empty for >60s (crash safety). AC: timer visible to all
  members, including those not in voice.
- **FR-25 Voice recording.** Any voice member can start/stop recording. The recorder's client
  mixes all remote audio + own mic (WebAudio) → `MediaRecorder` (opus/webm) → chunked upload → R2.
  Recordings are listed (who started, when, duration) and playable in-app. AC: a red REC indicator
  is visible to ALL voice members while recording; start/stop are activity-log entries; a 2-client
  e2e records ≥5s and plays it back.
- **FR-26 Self mute / deafen.** Mute stops publishing mic (track disabled); deafen additionally
  silences all incoming audio (voice + streams + soundboard). AC: state visible to all members.

### 1.5 Screen sharing & webcam

- **FR-27 Screen share** with quality presets — resolution **480p/720p/1080p/1440p** × fps
  **15/30/60** — publisher-switchable **on the fly** (no restart of the share). AC: preset changes
  apply via `applyConstraints`/`setParameters` without renegotiating viewers; e2e verifies a
  resolution change reflected in viewer `getStats`.
- **FR-28 Stream audio (game audio)** captured where the OS supports it (probed via
  `capture.loopbackAudioSupported()`):
  **Windows** — in-box via the display-media handler callback. Build 20348+ (Win11/Server 2022)
  passes the Chromium device id `'loopbackWithoutChrome'` (WASAPI process loopback,
  EXCLUDE_TARGET_PROCESS_TREE): system audio MINUS Tavern's own output, so voices/soundboard no
  longer echo into the stream. Electron's handler forwards any audio string verbatim as the device
  id (electron_browser_context.cc) — its d.ts union is narrower than the implementation. Older
  Windows falls back to `'loopback'` (endpoint capture; self-audio caveat stands). Device pick is
  the shared `loopbackAudioDevice()` (used by main capture + the preload's static
  `loopbackSelfAudioExcluded` flag, which suppresses the caveat toast where it would be a lie).
  **macOS** — in-box since Electron 39 via the CoreAudio tap (needs `NSAudioCaptureUsageDescription`
  in Info.plist; macOS ≤12.7.6 unsupported). Electron's own docs pages disagree with each other
  here, so S8.1's DoD includes a live macOS probe; failure path is pre-authorized in §3.7.
  macOS also gets `'loopbackWithoutChrome'`: the catap backend (14.2+, feature on by default)
  excludes the audio service's process objects; the SCK fallback (13+) sets
  `excludesCurrentProcessAudio` — both fail OPEN to full loopback if exclusion can't resolve.
  **Linux (desktop)** — REVISED 2026-07-12 (replaces the flag-gated loopback plan), LAYERED
  same-day (Task-3): the main process first tries **@vencord/venmic** (MPL-2.0, an
  `optionalDependency` — os:linux glibc x64/arm64 prebuilds only): gated on
  `PatchBay.hasPipeWire()`, it `link()`s a PipeWire virtual mic (upstream-hardcoded node
  `vencord-screen-share`) capturing application streams only (`ignore_devices`) with Tavern's own
  audio excluded at the SOURCE — `exclude [{ "application.process.id": <Electron audio-service
  pid> }]` — so no echo canceller sits in the content path (full music/game fidelity, no
  double-talk ducking). The renderer's auto-pick prefers that node above all, and captures it with
  `echoCancellation:false`. ANY venmic failure (no PipeWire, missing module/prebuild, no
  audio-service process yet, link error) falls back SILENTLY to the remap path below — which stays
  the web path and the non-PipeWire fallback. Packaging: `asarUnpack` the venmic tree +
  `npmRebuild:false` (N-API prebuilds; a rebuild would need PipeWire headers CI lacks). Per-app
  audio selection over venmic's include filter is an explicit FOLLOW-UP, not in scope.
  Fallback path: the main process wraps each audio share in a pactl `module-remap-source` clone of
  the default sink's monitor (`tavern_stream_audio`, description `TavernStreamMonitor` — SPACELESS,
  pipewire-pulse truncates multi-word descriptions; volume+mute pinned at creation against AGC
  drift), unloaded on share stop/app quit. Chromium never enumerates raw pulse monitors (audio_manager_pulse.cc
  filters them), but a remap-source IS enumerated; the renderer captures it via the FR-28
  fallback below. The `PulseaudioLoopbackForScreenShare` device path was probed on Electron 43 +
  pulse and REJECTED: its 'loopback' stream ignores echoCancellation and 'loopbackWithoutChrome'
  falls open (Chromium documents it Windows/Mac/ChromeOS-only), so Tavern voices would echo.
  **Web + Linux fallback (media/capture.ts captureScreen)** — when a wanted share resolves with
  NO display audio on a NON-tab surface (Chrome/Linux screen+window shares, Firefox everywhere),
  the renderer captures a system-audio input instead: the settings-picked device
  (`DeviceSettingsV1.streamAudio`, "auto"/"off"/deviceId — an explicit device also SUPERSEDES
  display audio), else `TavernStreamMonitor`, else the first /monitor/i-labeled input (Firefox
  lists pulse monitors; Chrome users can point "auto" at any user-made virtual source).
  Anti-loopback: the fallback captures with `echoCancellation:true` — Chromium's AEC reference is
  Chrome's own playout (chrome-wide AEC default-on since ~M110, WebAudio included), so Tavern
  voices/soundboard cancel OUT of the monitor while external app audio passes. Container-probed
  on real pulse: self-playout −54 dB, external untouched, 43.7 dB separation in double-talk.
  Known limitation (old-Windows <20348 endpoint loopback, and Windows/mac-web "system audio"
  picker audio, shown once in UI): loopback captures ALL system audio including Tavern's own
  output — voices/soundboard leak into the stream. Tab-audio shares carry no Tavern audio and get
  no caveat; the monitor fallback gets a "voices are filtered out" note instead.
  AC: viewer hears stream audio on supporting OSes, controlled by FR-31's slider, absent otherwise;
  e2e: explicit-device fallback publishes a screenAudio companion the watcher pulls (streams.spec).
- **FR-29 Webcam share** appears as a normal tile on the same canvas. AC: webcam + screen can be
  shared simultaneously by the same user (two tiles).
- **FR-30 Watching is opt-in.** Nobody receives a stream until they click it; users can watch any
  number of streams; unwatch anytime. AC: non-watching client has zero video subscriptions
  (verified via `getStats` — cost guardrail).
- **FR-31 Separate volumes**: per-stream audio volume slider, independent of voice volumes and of
  the soundboard volume. Local, persisted.
- **FR-32 Auto-layout** of tiles on the canvas exactly per §App-C (from `images/`). AC: unit tests
  lock the table for n=1..12; e2e screenshot-asserts 2-stream side-by-side.
- **FR-33 Viewers always pull the high simulcast layer** — grid, focused, and fullscreen tiles all
  receive best quality; focus/fullscreen is a layout toggle only (amended 2026-07-12; originally
  quality followed tile size). The `tracks/update` layer-switch path stays wired (a future
  data-saver toggle) but the default UI never downswitches. AC: `getStats` resolution on an
  UNFOCUSED grid tile reaches the high layer; no layer switch issued on focus/unfocus.

### 1.6 Soundboard

- **FR-34 Upload mp3** ≤5 min, ≤10 MB → R2; metadata (name, uploader, createdAt) per server.
- **FR-35 Trim** non-destructively: waveform UI selects `trimStartMs/trimEndMs`, stored as
  metadata; playback honors trim. Only the uploader (or admin) can edit/delete.
- **FR-36 Play for everyone**: pressing a sound broadcasts `sound.play`; every client **in voice**
  fetches (cached) and plays it locally, mixed into their output — NOT injected into WebRTC.
  AC: 2-client e2e asserts both clients play within 500ms of each other.
- **FR-37 Sound stats**: play count, who played, when; "most popular" ordering in the panel.
  Pinned scope: who-played/when are RETAINED in `sound_plays` (queryable later); v1 SURFACES only
  playCount + popularity ordering — the retained detail rows satisfy task.md's "keep" requirement.
- **FR-38 Soundboard volume**: separate local slider (0–200%), persisted.

### 1.7 Activity & stats

- **FR-39 Activity log** (per server, persisted, paginated UI tab): voice join/leave, stream
  start/stop, recording start/stop, member joined server, member kicked.
- **FR-40 Per-user stats** (per server): messages sent; hours streamed; hours watched broken down
  **per (viewer → streamer) pair** ("who do I watch the most"). Server-authoritative (computed by
  the DO from its own watch/stream session records, not client-reported). UI tab shows a members
  table + "you watch most" ranking.

### 1.8 Platform & shell

- **FR-41 Multi-server** membership with instant switching (state per server preserved).
- **FR-42 Web version**: the identical React app served by the Worker (same origin as API). Feature
  parity except: no system-audio loopback, browser-native screen picker, web Notifications API,
  no auto-update. AC: full auth+chat+voice e2e passes on chromium against the deployed worker.
- **FR-43 Boot loading gate**: on launch/refresh, a single global loader shows until session +
  server list + active-server snapshot are loaded; the UI never flashes a wrong intermediate state.
  AC: e2e reload test asserts loader → correct state with no intermediate flash.
- **FR-44 Auto-update** (Electron): app checks GitHub Releases, downloads in background, shows a
  "Restart to update" pill; restart applies. AC: verified with a real published pre-release in S12.
- **FR-45 Presence** in the People panel: offline / online / in-voice, live.

### 1.9 Non-goals (v1) — implementers must NOT build these

No message edit/delete/reactions/threads/search, no DMs, no friends list, no unread badges, no
typing indicators, no roles beyond admin/member, no multi-channel UI, no offline push
notifications, no mobile, no E2EE, no OAuth/email/password-reset, no avatar cropper UI, no
user-count scaling beyond 10/server. Adding any of these = R1 violation.

---

## §2 — Architecture

```
┌────────────── Electron desktop ──────────────┐      ┌───── Web browser ─────┐
│ main process (window, IPC, capture picker,   │      │ same React app served │
│ notifications, safeStorage, autoUpdater)     │      │ by the Worker (assets)│
│   └─ preload (contextBridge: window.tavern)  │      └───────────┬───────────┘
│ renderer = @tavern/app (React 19 + Vite)     │                  │
└───────────────────┬──────────────────────────┘                  │
                    │ HTTPS + WSS (same API)                      │
                    ▼                                             ▼
┌──────────────────────── Cloudflare Worker (@tavern/worker, Hono) ───────────────────────┐
│ /api/auth/* BetterAuth (D1)   /api/servers/* catalog (D1)   /api/rtc/* SFU proxy        │
│ /api/media/* R2 streaming     static assets = built @tavern/app (web version)           │
│      └── routes WS upgrades + per-server ops to ─────────────┐                          │
└──────────────────────────────────────────────────────────────┼──────────────────────────┘
        │D1: auth, users, servers,        │R2: avatars,        ▼
        │memberships, settings            │sounds, recordings  ┌──────────────────────────┐
        ▼                                 ▼                    │ ServerRoom DO (1/server) │
   [D1 database]                     [R2 bucket]               │ WS hibernation, presence,│
                                                               │ chat, activity, voice    │
                                                               │ state, soundboard events,│
                                                               │ stats, cost meter, alarm │
                                                               │ (own SQLite storage)     │
                                                               └──────────────────────────┘
                    media (SRTP) ▲
                                 ▼
                 [Cloudflare Realtime SFU]  ← Worker proxies its HTTP API; app token never
                                              reaches clients; STUN/TURN via CF
```

Pinned decisions (rationale kept for humans; implementers just obey):

- **A1 — One React app (`@tavern/app`) for desktop renderer and web.** Platform differences go
  through one `platform/` abstraction (§4) — never `if (isElectron)` scattered in features.
- **A2 — One Durable Object per server** (`ServerRoom`, SQLite-backed) owns all per-server
  realtime state and history. D1 owns global data (auth, users, server catalog, memberships,
  settings). R2 owns binary media.
- **A3 — Realtime SFU, never P2P mesh.** Verified working from browsers. Publisher = SDP offerer;
  puller = SDP answerer (the SFU offers on pull — do not invert). All SFU HTTP calls go through
  the Worker proxy which enforces caps and meters egress (§8).
- **A4 — Client WS auth via one-time ticket**: `POST /api/ws-ticket` → 30s single-use ticket →
  `wss:///api/servers/:id/ws?ticket=…`. (Browsers can't set WS headers; tokens never appear in
  URLs that outlive 30s.) The Worker validates session + membership at ticket ISSUANCE and asks
  the DO to mint the ticket (bound to userId); at upgrade time the DO consumes the ticket
  (single-use, expiry) and resolves userId from it — invalid → accept-then-close 4002. The DO
  never sees auth tokens.
- **A5 — Sessions**: BetterAuth; Electron uses bearer tokens stored via `safeStorage` (IPC),
  web uses same-origin cookies. One `authTransport` module hides the difference. Keyring-less
  Linux falls back to Chromium's basic v10 obfuscation (Electron `setUsePlainTextEncryption`,
  same scheme Chrome uses there); if even that fails (dead keyring daemon) the token is held
  in memory for the process so login still works.
- **A6 — Client connects a WS to EVERY joined server** while running (presence + notifications
  across servers); hibernation makes idle sockets ~free. Voice/media only on the active server.
- **A7 — Soundboard audio never touches WebRTC** (FR-36 pinned mechanism).
- **A8 — Recording is client-side mixing** (FR-25) — the SFU has no recording primitive we rely on.
- **A9 — All boundaries are zod-validated**: HTTP bodies, WS messages (both directions), IPC
  payloads, and D1/DO rows read back from SQL. Schemas live ONLY in `@tavern/shared`.
- **A10 — Renderer never talks to Electron APIs directly** — only `window.tavern` (typed,
  contextBridge, zod-validated per §9.8; `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`).

---

## §3 — Pinned technology stack (exact versions, verified against live docs 2026-07-09)

Install with `pnpm add -E` / `pnpm add -DE` (exact). This is the COMPLETE dependency list (R2/§9.11).

### 3.1 Toolchain

| What | Pin | Notes / doc |
|---|---|---|
| Node | 22 LTS (≥22.12) | electron-vite engines require ^20.19 or ≥22.12 |
| pnpm | 11.10.0 | root `packageManager` field; workspace protocol for `@tavern/*` |
| TypeScript | **7.0.2** | the native (Go) compiler, released 2026-07 — ~10× faster typechecks. Caveat: it does NOT expose the legacy JS compiler API, so no repo script may `import 'typescript'` (use oxc-parser). Contingency §3.7 if it rejects a config/deps' types. |
| oxc-parser | 0.139.0 | dev-only: AST parsing for repo check scripts (i18n literal gate §9.6) — the TS7-era replacement for the old TS compiler API |
| Vite | ^7 (latest 7.x) | ALL packages. Vite 8 exists but electron-vite 5.0.0 peers `^5\|\|^6\|\|^7` — do not install 8. |
| oxlint | 1.73.0 | linter (Rust, fastest available); root `.oxlintrc.json` with `typescript`, `react`, `react-hooks`, `import`, `unicorn` plugin categories enabled — oxc.rs |
| oxfmt | 0.58.0 | formatter (Prettier-compatible, beta). Config `.oxfmtrc.json`; Tailwind class sorting via `sortTailwindcss: { stylesheet, functions: ["cn"] }` (added in S4.2 when the stylesheet exists). Covers JS/TS/JSX/TSX — other file types stay unformatted (pinned: no Prettier). Contingency §3.7. |

### 3.2 Desktop

| What | Pin | Notes / doc |
|---|---|---|
| electron | 43.1.0 (exact) | Chromium 150 / Node 24.18 — releases.electronjs.org |
| electron-vite | 5.0.0 | builds main+preload; renderer is `@tavern/app` (§4) — electron-vite.org |
| electron-builder | ^26.0.0 (resolves 26.15.6) | `latest` dist-tag lags at 26.15.3; NEVER the `next` tag (27-alpha) — electron.build |
| electron-updater | 6.8.9 | GitHub Releases provider — electron.build/docs/features/auto-update |
| AppImage toolset | `toolsets: { appimage: "1.0.3" }` | static runtime, no FUSE2 — required for Void/Ubuntu 24.04+ — electron.build/docs/appimage |

**Electron Forge — evaluated and REJECTED (2026-07-10; pinned, do not re-litigate).** Verified
against live docs: Forge has no official AppImage maker (only the single-maintainer community
`@reforged/maker-appimage`); Forge generates none of the `latest*.yml` electron-updater metadata
(forge#547, open since 2018) and its blessed update path (update.electronjs.org) requires a
public repo, covers only macOS+Windows, and has zero AppImage support; its own vite plugin is
still marked experimental. electron-builder satisfies every hard requirement out of the box:
static-runtime AppImage, auto-update for unsigned NSIS + mac zip + AppImage from GitHub Releases,
documented electron-vite 5 integration. Any suggestion to switch to Forge is an R1 stop.

### 3.3 Frontend (`@tavern/app`)

| What | Pin | Notes / doc |
|---|---|---|
| react / react-dom | 19.2.7 | react.dev/versions |
| react-router | 8.2.0 | declarative mode; HashRouter (desktop) / BrowserRouter (web) — follow current v8 docs |
| @tanstack/react-query | 5.101.2 | all REST reads/mutations |
| zustand | 5.0.14 | realtime/WS + media state |
| tailwindcss + @tailwindcss/vite | 4.3.2 (both) | CSS-first config, NO tailwind.config.js; dark mode = `@custom-variant dark (&:where(.dark, .dark *));` — tailwindcss.com/docs/dark-mode |
| shadcn CLI | 4.13.0 | `pnpm dlx shadcn@latest init -b base` — Base UI is the default since 2026-07 but pin `-b base` explicitly; docs: ui.shadcn.com/docs/installation/vite |
| shadcn MCP server | official, via `shadcn@latest mcp` | agent-facing tool, NOT an app runtime dependency (exempt from R2's "complete dependency list" — nothing to `pnpm add`). Installed S4.2 via `pnpm dlx shadcn@latest mcp init --client claude` (writes project-level `.mcp.json`, no token needed for the standard registry). Every implementer touching `components/ui/*` MUST use it per R10 — it serves the actual current Base UI component source instead of an agent's (Radix-era) training-data memory; docs: ui.shadcn.com/docs/mcp |
| @base-ui/react | 1.6.0 | the RENAMED package — reject any `@base-ui-components/react` import (dead pre-1.0 name). Root element needs `isolation: isolate`. Zero Radix anywhere (grep-gate in CI). |
| frimousse | 0.3.0 | emoji picker, shadcn registry component (`shadcn add https://frimousse.liveblocks.io/r/emoji-picker`), peers react ^18\|\|^19 ✓ |
| sonner | 2.0.7 | toasts (radix-free, shadcn-endorsed) |
| react-hook-form | 7.81.0 | + @hookform/resolvers 5.4.0 (`zodResolver` auto-detects zod 4 — plain `import { z } from 'zod'`) |
| zod | 4.4.3 | v4 is current major; the ONLY dep of `@tavern/shared` |
| @inlang/paraglide-js | 2.21.0 | compiler-based i18n (no runtime lib): `npx @inlang/paraglide-js init`; `paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide', strategy: ['localStorage','baseLocale'] })`; messages in `app/messages/{en,uk}.json`; usage `import { m } from '@/paraglide/messages.js'` → `m.key()`; locale switch = `setLocale(l, { reload: false })` + root re-render — paraglidejs.com |
| wavesurfer.js | 7.12.10 | Regions plugin bundled (`wavesurfer.js/dist/plugins/regions.esm.js`); Shadow-DOM — style regions via options, not CSS |

### 3.4 Backend (`@tavern/worker`)

| What | Pin | Notes / doc |
|---|---|---|
| wrangler | 4.110.0 | wrangler.jsonc; `compatibility_date: "2026-07-09"` (gets `web_socket_auto_reply_to_close` + deleteAll-clears-alarm); `compatibility_flags: ["nodejs_compat"]` |
| hono | 4.12.28 | router; auth mounted per-request (see below) |
| better-auth | 1.6.23 | 1.7 is rc-only — do not use. CLI is `npx auth@latest` (the old `@better-auth/cli` is stalled at 1.4 — never use it) |
| drizzle-orm / drizzle-kit | 0.45.2 / ≥0.31.4 | ONLY as better-auth's adapter + generated auth schema. App tables use raw D1 prepared statements + `wrangler d1 migrations` — no ORM. |
| music-metadata | 11.13.0 | mp3 sniff + duration in Worker (`parseBuffer`; ESM-only) |
| types | via `wrangler types` | do not hand-pin @cloudflare/workers-types |

BetterAuth pinned config facts (S1.2 implements exactly this):
per-request factory from `env` (NEVER module scope — D1 binding is per-request);
`emailAndPassword: { enabled: true }` + `username()` plugin + `bearer()` plugin;
**signup requires an email field → synthesize `${username}@users.tavern.invalid` server-side,
never render it anywhere** (no email-free signup exists — upstream discussion #5896);
bearer token arrives in the `set-auth-token` response header after sign-in;
`rateLimit: { enabled: true, storage: "database", customRules: { "/sign-in/username": { window: 10, max: 3 }, "/sign-up/email": { window: 60, max: 5 } } }`
(default in-memory storage is per-isolate = useless on Workers);
schema pipeline: `npx auth@latest generate` (against a static CLI-only auth config) → `drizzle-kit
generate` → `wrangler d1 migrations apply` (the auth CLI's own `migrate` cannot target D1);
session reads via `auth.api.getSession({ headers })` (works for cookie AND bearer);
post-response work must go through `ctx.waitUntil` (Hono `c.executionCtx`).

### 3.5 Testing & CI

| What | Pin | Notes / doc |
|---|---|---|
| vitest | 4.1.10 | one version repo-wide — pool-workers peers `^4.1.0` |
| @cloudflare/vitest-pool-workers | 0.18.4 | NEW config style: `cloudflareTest({ wrangler: { configPath } })` Vite plugin — old `defineWorkersConfig`/`poolOptions` snippets are obsolete |
| @vitest/coverage-istanbul | 4.1.10 | istanbul EVERYWHERE (V8 coverage is hard-rejected inside workerd) |
| @testing-library/react / jsdom | 16.3.2 / 29.1.1 | renderer unit/integration tests |
| @playwright/test | 1.61.1 | Electron support official-but-experimental; chromium for web e2e |
| GH Actions | actions/checkout@v4, actions/setup-node@v4, ubuntu/macos/windows-latest | electron.build/docs/features/github-actions |

### 3.6 Version-trap ledger (things an implementer WILL get wrong without this)

1. TypeScript 7 is the native compiler: `tsc` CLI + tsconfig work, but the old JS compiler API is
   gone — scripts that need an AST use `oxc-parser`, never `import ts from 'typescript'`.
2. `vite` latest = 8.x → pin ^7 (electron-vite peer range).
3. `electron-builder` latest tag ≠ newest 26.x → use `^26.0.0`, never `next`.
4. better-auth CLI = `npx auth@latest`, NOT `@better-auth/cli`.
5. Base UI package = `@base-ui/react`, NOT `@base-ui-components/react`.
6. shadcn init MUST pass `-b base`; copied doc snippets must come from the Base UI tab
   (Base UI popups use `[data-open]`/`[data-starting-style]`, not Radix `[data-state=…]`).
7. vitest-pool-workers config = `cloudflareTest()` Vite plugin (2026 style).
8. DO migrations = `new_sqlite_classes` (NOT `new_classes` — that's the paid-only KV backend).
9. Electron fake-media flags via `app.commandLine.appendSwitch` in main gated by env var —
   Playwright `launch({ args })` flags are unreliable (playwright#16621).
10. Realtime SFU: `tracks/close` and `renegotiate` are **PUT**; pull = SFU offers/client answers.
11. shadcn/Base UI component markup: do NOT write component internals from training-data memory —
    pre-Base UI shadcn examples online (and in most agents' training data) are Radix-flavored
    (`[data-state=…]`). Query the shadcn MCP server (R10, §3.3) or read the generated source in
    `src/components/ui/*` — both reflect the real Base UI attributes (`[data-open]`/
    `[data-starting-style]`).

### 3.7 Pre-authorized contingencies (fallbacks that are NOT R1 stops — execute, then record in progress.md)

| If this happens | Do exactly this |
|---|---|
| `vitest --coverage` in worker fails per workers-sdk#12951 | pin `@vitest/coverage-istanbul@4.0.18` in `worker/` only |
| TypeScript 7.0.2 rejects a pinned tsconfig option or crashes on a dependency's types | pin `typescript@5.9.3` repo-wide instead (tsconfig unchanged) |
| oxfmt (beta) mangles or errors on a source file | exclude it via `ignorePatterns` in `.oxfmtrc.json` + note in progress.md; if systemic, swap formatter to `prettier@3.9.5` repo-wide |
| `music-metadata` fails under workerd (S9.1 smoke) | Worker validation = size cap + magic bytes only; duration validated client-side via `decodeAudioData` |
| macOS `audio:'loopback'` yields no audio in the S8.1 probe (docs are internally inconsistent; PR electron#47493 open) | ship macOS screen share video-only, set `loopbackAudioSupported()=false` on darwin, file an informational blocker |
| Apple signing secrets absent at S12.2 | unsigned mac build, `autoUpdater` disabled on darwin via config flag, blocker filed |
| DataChannels body casing (`dataChannels` vs `datachannels`) | not used in v1 — ignore |

---

## §4 — Repository layout (exact; created in S0.1–S0.3)

```
tavern/                              # pnpm workspace, Node 22 LTS, TS strict everywhere
├── package.json                     # workspace root: scripts, devDeps shared by all packages
├── pnpm-workspace.yaml              # packages: shared, worker, app, desktop
├── tsconfig.base.json               # strict base config all packages extend
├── shared/                          # @tavern/shared — types, schemas, pure logic. Deps: zod only.
│   └── src/
│       ├── protocol.ts              # WS message catalog (§App-A) as zod discriminated unions
│       ├── api.ts                   # REST request/response schemas (§6.1)
│       ├── ipc.ts                   # window.tavern IPC contract schemas (§6.3)
│       ├── domain.ts                # UserProfile, Member, StreamInfo, Presence, … (§5.4)
│       ├── presets.ts               # stream presets + bitrate/simulcast tables (§App-D)
│       ├── layout.ts                # canvas auto-layout algorithm (§App-C) — pure function
│       ├── limits.ts                # every numeric constant in the product (§App-B)
│       └── errors.ts                # ErrorCode enum shared by API/WS/UI i18n
├── worker/                          # @tavern/worker — Cloudflare Worker + ServerRoom DO
│   ├── wrangler.jsonc               # bindings: DB(D1) MEDIA(R2) SERVER_ROOM(DO) + assets
│   ├── migrations/                  # D1 SQL migrations (wrangler d1 migrations)
│   └── src/
│       ├── index.ts                 # Hono app assembly + asset serving
│       ├── auth.ts                  # BetterAuth instance (username+bearer plugins, D1)
│       ├── middleware.ts            # session→ctx, rate limits, zod validation helper
│       ├── routes/                  # one file per resource: me.ts servers.ts rtc.ts
│       │                            #   sounds.ts recordings.ts media.ts wsTicket.ts
│       ├── rtc/realtime.ts          # typed Cloudflare Realtime API client (fetch)
│       └── do/
│           ├── ServerRoom.ts        # DO class: WS lifecycle + message router ONLY
│           ├── roomState.ts         # presence/members/voice-session state machine
│           ├── chat.ts              # messages + mentions + history      (SQLite)
│           ├── activity.ts          # activity log                       (SQLite)
│           ├── soundboard.ts        # sound metadata + play events       (SQLite)
│           ├── recordings.ts        # recording registry                 (SQLite)
│           ├── stats.ts             # counters + watch-pair accumulation (SQLite)
│           ├── costMeter.ts         # egress estimation + kill switch    (§8)
│           └── sql.ts               # migrations + typed row mappers for DO SQLite
├── app/                             # @tavern/app — React renderer (desktop + web)
│   ├── index.html                   # strict CSP
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx                 # bootstraps router + providers + boot gate
│       ├── router.tsx               # routes: /login /register /join /s/:serverId (§7.6)
│       ├── platform/                # THE abstraction over desktop/web differences
│       │   ├── types.ts             # PlatformBridge interface (§6.3)
│       │   ├── electron.ts          # implements via window.tavern
│       │   └── web.ts               # implements via web APIs
│       ├── lib/                     # apiClient.ts (fetch+zod), wsClient.ts (reconnect/resync),
│       │   │                        # queryClient.ts, authTransport.ts
│       ├── media/                   # pure-TS media engine, unit-tested with mocked WebRTC:
│       │   ├── rtc/                 #   publishSession.ts, pullSession.ts, sfuSignal.ts
│       │   ├── audioGraph.ts        #   per-user/stream/soundboard gain graph + output sink
│       │   ├── levelMeter.ts        #   speaking detection (AnalyserNode)
│       │   ├── capture.ts           #   mic/webcam/screen acquisition via platform bridge
│       │   ├── recorder.ts          #   FR-25 mixer + MediaRecorder + chunked upload
│       │   └── soundboardPlayer.ts  #   FR-36 fetch/decode/trim/play
│       ├── stores/                  # zustand: session.ts servers.ts room.ts media.ts settings.ts
│       ├── features/                # UI only — logic lives in stores/media/lib
│       │   ├── auth/  boot/  servers/  chat/  voice/  streams/  soundboard/
│       │   ├── recordings/  activity/  stats/  admin/  settings/  shell/
│       ├── components/ui/           # shadcn-generated primitives (Base UI) — generated, don't edit
│       ├── paraglide/               # GENERATED by the paraglide compiler (gitignored)
│       └── styles/app.css           # tailwind entry + theme tokens
│   ├── messages/                    # en.json, uk.json — paraglide source messages (§9.6)
│   ├── project.inlang/              # inlang project settings (committed)
├── desktop/                         # @tavern/desktop — Electron main + preload only
│   ├── electron-builder.yml
│   └── src/
│       ├── main/                    # index.ts window.ts ipc.ts capture.ts notifications.ts
│       │                            # updates.ts secrets.ts singleInstance.ts
│       └── preload/index.ts         # contextBridge → window.tavern (implements shared/ipc.ts)
├── e2e/                             # Playwright: web/*.spec.ts, desktop/*.spec.ts, harness/
├── docs/                            # PLAN.md steps/ progress.md blockers.md
└── .github/workflows/               # ci.yml deploy.yml release.yml nightly.yml
```

Placement rules (enforced in review): pure logic → `shared` if used by ≥2 packages, else the
package's non-UI layer. React components contain **zero** business logic. A file that mixes
concerns fails review (§9.2).

---

## §5 — Data model

### 5.1 D1 (global database, name `tavern-db`)

> **Pre-provisioned — REUSED, never created.** The database already exists on the personal
> Cloudflare account: `database_id: 49d52212-7fd9-4d4e-a7dd-d48f90dc0219`. It was hard-wiped on
> 2026-07-10 (every table of the abandoned implementation dropped; only D1 internals remain).
> S1.1 binds this id verbatim; running `wrangler d1 create` is an R1 violation.

BetterAuth generates its own tables (user/session/account/verification + rateLimit) via its CLI —
S1.2 runs that generator; we never hand-edit those migrations. We extend the `user` table via
BetterAuth `additionalFields` (not a separate profile table): `displayName TEXT NOT NULL`,
`color TEXT NOT NULL DEFAULT '#e0e0e0'`, `avatarKey TEXT` (R2 key or NULL). The `email` column
holds the synthetic `${username}@users.tavern.invalid` value (§3.4) — it exists only to satisfy
BetterAuth's schema, is updated in the same transaction on username change, and never appears in
any API response or UI.

App-owned tables (D1 migrations, exact DDL in step S2.1):

```sql
servers(
  id TEXT PRIMARY KEY,                   -- crypto.randomUUID()
  nickname TEXT NOT NULL COLLATE NOCASE UNIQUE,   -- 3..32 chars, rules §App-B
  password_hash TEXT,                    -- NULL = open server; scrypt via better-auth's hasher
  admin_user_id TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL            -- epoch ms (all timestamps in the app)
)
memberships(
  user_id TEXT NOT NULL REFERENCES user(id),
  server_id TEXT NOT NULL REFERENCES servers(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_id)
)
channels(                                 -- FR-13: schema ready, UI fixed to the 2 defaults
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  kind TEXT NOT NULL CHECK (kind IN ('voice','text')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
user_settings(
  user_id TEXT PRIMARY KEY REFERENCES user(id),
  notify_all INTEGER NOT NULL DEFAULT 1,
  notify_mentions INTEGER NOT NULL DEFAULT 1,
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','uk')),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system'))
)
server_creation_codes(         -- FR-08: one-time, operator-seeded codes gating create
  code TEXT PRIMARY KEY,       -- the literal code an operator hands out
  created_at INTEGER NOT NULL, -- epoch ms
  used_by_user_id TEXT,        -- user(id); NULL until claimed
  used_at INTEGER,             -- NULL until claimed; non-NULL = burned (single-use)
  created_server_id TEXT       -- servers(id); the server this code created. NO FK clauses on this
                               -- table: the route stamps the claim BEFORE the servers row commits.
)
```

### 5.2 ServerRoom DO SQLite (per server; DDL in step S3.1, applied idempotently on first fetch)

```sql
members(user_id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
        color TEXT NOT NULL, avatar_key TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL)
        -- cache of D1 membership+profiles, pushed by Worker internal routes (member join/kick/
        -- profile update); lets the DO resolve mentions & snapshots without cross-service reads
messages(id INTEGER PRIMARY KEY AUTOINCREMENT,
         channel_id TEXT NOT NULL DEFAULT 'main',  -- FR-13 readiness; v1 always writes 'main'
         user_id TEXT NOT NULL, body TEXT NOT NULL,
         mentions TEXT NOT NULL DEFAULT '[]',   -- JSON array of userIds
         created_at INTEGER NOT NULL)
activity(id INTEGER PRIMARY KEY AUTOINCREMENT,
         type TEXT NOT NULL,                    -- enum §App-A activity.types
         user_id TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)
sounds(id TEXT PRIMARY KEY, name TEXT NOT NULL, uploader_id TEXT NOT NULL,
       r2_key TEXT NOT NULL, duration_ms INTEGER NOT NULL,
       trim_start_ms INTEGER NOT NULL DEFAULT 0, trim_end_ms INTEGER NOT NULL,
       created_at INTEGER NOT NULL)
sound_plays(id INTEGER PRIMARY KEY AUTOINCREMENT, sound_id TEXT NOT NULL,
            user_id TEXT NOT NULL, created_at INTEGER NOT NULL)
recordings(id TEXT PRIMARY KEY, started_by TEXT NOT NULL, r2_key TEXT NOT NULL,
           upload_id TEXT,           -- R2 multipart id while in-flight; NULL after finalize
           duration_ms INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER)
voice_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,
               channel_id TEXT NOT NULL DEFAULT 'main',  -- FR-13 readiness; v1 always 'main'
               started_at INTEGER NOT NULL, ended_at INTEGER)
stat_stream_seconds(user_id TEXT PRIMARY KEY, seconds INTEGER NOT NULL DEFAULT 0)
stat_watch_seconds(viewer_id TEXT NOT NULL, streamer_id TEXT NOT NULL,
                   seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (viewer_id, streamer_id))
egress_log(month TEXT PRIMARY KEY,              -- 'YYYY-MM'
           bytes INTEGER NOT NULL DEFAULT 0)
```

Messages-sent stat = `SELECT user_id, COUNT(*) FROM messages GROUP BY user_id` (no counter table).
Watch/stream seconds are accumulated by the DO from its OWN join/leave/watch events with server
timestamps — clients never report durations (tamper-proof, consistent).

### 5.3 R2 (bucket `tavern-media`) key scheme

> **Pre-provisioned — REUSED, never created.** `tavern-media` exists (created empty 2026-07-10 on
> the personal account); S1.1 binds it, never creates it. The abandoned implementation's leftovers
> (`tavern-avatars`, `tavern-updates` buckets and the old `tavern` worker with its ServerRoom DO
> namespace + storage) were deleted the same day — the first `wrangler deploy` creates the worker
> fresh, so the pinned DO migration `tag: "v1"` starts from clean history.

```
avatars/{userId}.webp
sounds/{serverId}/{soundId}.mp3
recordings/{serverId}/{recordingId}.webm
```

All reads go through `GET /api/media/:key` (session + membership checked; streamed with
`Content-Type`, `ETag`, `Cache-Control: private, max-age=86400`). No public buckets, no presigned
URLs in v1 (files ≤ ~200MB stream fine through the Worker; recording upload is chunked multipart).

### 5.4 Shared domain types (implemented as zod in `shared/src/domain.ts`, S0.2)

`UserProfile { userId, username, displayName, color, avatarKey? }` ·
`Member = UserProfile & { presence: 'offline'|'online'|'in-voice', isAdmin, joinedAt }` ·
`StreamInfo { trackName, kind: 'screen'|'webcam', userId, hasAudio, preset: PresetId }` ·
`VoiceState { members: VoiceMember[], sessionStartedAt: number|null }` ·
`VoiceMember { userId, muted, deafened, micSeq?, speaking? (client-derived, not on wire) }`
(`micSeq` — bumped by the DO whenever the member's `mic:{uid}` track (re)registers on a publish;
peers re-pull on a change, since a rejoin/transport-recovery re-registers the SAME trackName under
a NEW SFU session with no other roster-visible signal) ·
`RecordingState { active: boolean, recordingId?, startedBy?, startedAt? }` ·
`VolumesV1 { users: Record<userId, number 0..2>, streams: Record<trackName, number 0..2>,
soundboard: number 0..2, mutedUsers: userId[] }` (the localStorage `settings.volumes.v1` schema)

---

## §6 — API surface

### 6.1 REST (Worker, all under `/api`, all bodies zod-validated, errors = `{ error: ErrorCode }`)

| Method & path | Auth | Purpose / notes |
|---|---|---|
| `POST /api/auth/*` | — | BetterAuth mount (login/logout/session); responses pass an email-stripping middleware (the synthetic email never leaves the server) |
| `POST /api/auth-wrap/register` | — | FR-01 register wrapper: `{ username, password, repeatPassword }` (server-side equality check) → synthesizes the email → `auth.api.signUpEmail` |
| `GET /api/me` | session | profile + settings + joined servers (the boot call, FR-43) |
| `PATCH /api/me/profile` | session | `{ displayName?, color?, username? }` → fan-out `member.update` to joined-server DOs |
| `POST /api/me/avatar` | session | body = webp bytes ≤ `LIMITS.avatarMaxBytes`; magic-byte check; → R2 |
| `GET/PUT /api/me/settings` | session | `user_settings` row (FR-16, FR-06, FR-07) |
| `POST /api/servers` | session | create (FR-08): `{ nickname, password, code }` (`code` = one-time creation code → 403 `invalid_code` if spent/unknown); creator=admin; seeds 2 channels; joins creator |
| `POST /api/servers/join` | session | `{ nickname, password? }` (FR-09) |
| `GET /api/servers/:id/members` | member | member profiles (presence comes via WS) |
| `PATCH /api/servers/:id` | admin | `{ nickname?, password? }` (FR-10 replace-only — a server password is always set; FR-12) → DO `server.updated` |
| `DELETE /api/servers/:id/members/:userId` | admin | kick (FR-11) → D1 delete + DO eviction |
| `POST /api/ws-ticket` | session | `{ serverId }` → `{ ticket }` one-time, 30s TTL (A4; stored in DO) |
| `GET /api/servers/:id/ws?ticket=` | ticket | WS upgrade → ServerRoom DO |
| `GET /api/servers/:id/activity?before&limit` | member | proxied to DO (reads that don't need push are HTTP) |
| `GET /api/servers/:id/stats` | member | proxied to DO (FR-40 snapshot) |
| `GET /api/servers/:id/sounds` | member | soundboard list w/ stats (FR-34/37) |
| `POST /api/servers/:id/sounds` | member | multipart mp3 + `{ name, durationMs }`; validation §App-B |
| `PATCH /api/servers/:id/sounds/:soundId` | uploader/admin | `{ name?, trimStartMs?, trimEndMs? }` |
| `DELETE /api/servers/:id/sounds/:soundId` | uploader/admin | removes R2 object + row |
| `POST /api/servers/:id/recordings` | member-in-voice | open multipart upload → `{ recordingId, uploadId }` |
| `PUT /api/servers/:id/recordings/:recId/part?n=&uploadId=&final=` | starter | uploads part n (R2 multipart; client holds uploadId — Worker stays stateless; non-final parts must equal `recordingPartBytes`) |
| `POST /api/servers/:id/recordings/:recId/complete` | starter | `{ parts, durationMs }` finalize |
| `POST /api/servers/:id/recordings/:recId/abort` | starter | aborts the R2 multipart upload + cancels the DO recording row |
| `DELETE /api/servers/:id/recordings/:recId` | starter/admin | removes R2 object + row |
| `GET /api/servers/:id/recordings` | member | list (FR-25) |
| `GET /api/media/*` | member† | streamed R2 read (†avatars: any authed user) |
| `POST /api/rtc/:serverId/session` | member-in-voice | → SFU `sessions/new`; registers session in DO |
| `POST /api/rtc/:serverId/tracks` | member-in-voice | publish (`location:'local'`) or pull (`location:'remote'`); Worker enforces §8 caps; DO registers publishes / meters pulls |
| `PUT /api/rtc/:serverId/renegotiate` | member-in-voice | passthrough |
| `PUT /api/rtc/:serverId/tracks/update` | member-in-voice | simulcast layer switch (FR-33); DO reprices the watch grant (`op:'layer'`) for the cost meter |
| `POST /api/rtc/:serverId/close` | member-in-voice | closes tracks/session; DO unregisters |
| `GET /api/rtc/ice` | session | `{ iceServers }` — STUN + short-lived TURN creds from CF |

Rate limits (middleware, numbers in §App-B): auth endpoints, chat is WS-side, uploads, rtc.

### 6.2 WS protocol — see §App-A for the complete message catalog

Framing: JSON text frames, every frame validated against the §App-A zod union — **both
directions, both sides**. Unknown/invalid inbound frame → `error{code:'bad_message'}` + close 1008.
Client reconnect: exponential backoff 1s·2ⁿ capped 30s ±20% jitter; on reconnect the server
replays a full snapshot (`hello.ok`) and the client rebuilds state (no delta sync).

### 6.3 IPC (`window.tavern`, contract in `shared/src/ipc.ts`, implemented S4.1)

```
platform: 'win32'|'darwin'|'linux'      // window.tavern is desktop-only; the renderer-side
                                        // PlatformBridge (S4.3) adds kind:'desktop'|'web' on top
secrets:       getToken(): Promise<string|null> · setToken(t|null)         // safeStorage
capture:       getScreenSources(): Promise<ScreenSource[]>                 // id,name,thumbnailDataUrl,appIcon?
               selectSource(id|null): Promise<void>                        // arms setDisplayMediaRequestHandler
               loopbackAudioSupported(): Promise<boolean>                  // per-OS probe (FR-28)
notifications: show({title,body,tag}) · onClick(cb)                        // main-process Notification
updates:       onUpdateReady(cb) · restartToUpdate()                       // IPC channel: 'update://ready'
shell:         setBadge(count|null) · focusWindow()   // setBadge: RESERVED for post-v1 unread
                                                      // badges (§1.9) — implement, never call

```

Every method's args/returns have zod schemas; preload validates inbound, renderer validates
outbound. The web `platform/web.ts` implements the same interface (capture→getDisplayMedia native
picker, notifications→Notification API, updates→no-op, secrets→cookie-based no-op).

---

## §7 — Media plan (voice, streams, soundboard, recording)

### 7.1 SFU sessions & tracks (A3)

Per client in voice, exactly three kinds of RTCPeerConnection:

1. **publishPC** (1 per client): created on voice join; publishes `mic` track; screen/webcam
   tracks are added/removed on the same session (`tracks/new` + renegotiate). Client = offerer.
2. **voicePullPC** (1 per client): pulls ALL remote mic tracks; add/remove on member join/leave
   via `tracks/new`(remote)+renegotiate. SFU = offerer, client = answerer (do not invert).
3. **watchPC** (1 per watched stream): pulls that stream's video (+audio if `hasAudio`). Created
   on watch, closed on unwatch — isolates renegotiation churn per FR-30/33.

Track naming (registered in the DO, broadcast via `stream.added`):
`mic:{userId}` · `screen:{userId}:{n}` · `screenAudio:{userId}:{n}` · `cam:{userId}` (n = stable
per-share counter so a stop/start is a new name; prevents stale-subscription races).

SFU mechanics (verified against the live OpenAPI spec — deviations are R1 stops):
- Base `https://rtc.live.cloudflare.com/v1`, `Authorization: Bearer <APP_SECRET>` — Worker-side only.
- `POST /apps/{appId}/sessions/new` → `{sessionId}`; `POST .../tracks/new` for publish
  (`location:'local'`, client offer) and pull (`location:'remote'`, publisher `sessionId` +
  `trackName`); **`renegotiate` and `tracks/close` are PUT** (`tracks/close` takes the mid + a
  fresh offer, or `force:true`).
- Any response with `requiresImmediateRenegotiation:true` (typical on pulls/closes) MUST be
  answered immediately: `setRemoteDescription(offer)` → `createAnswer` → `PUT renegotiate`.
- Viewer layer switch (FR-33) = `PUT .../tracks/update` with `simulcast: { preferredRid }` on the
  existing pull — no PC teardown.
- Tracks are garbage-collected after ~30s without packets. Therefore self-mute = `track.enabled =
  false` (silence frames keep flowing); NEVER `replaceTrack(null)` to pause a published track.
- Rate limit: 50 API calls/sec per session — irrelevant at our scale but the Worker proxy still
  serializes renegotiations per session (queue, no parallel SDP ops on one session).

ICE: `iceServers` from `GET /api/rtc/ice` — STUN `stun.cloudflare.com:3478` + Cloudflare TURN
short-TTL credentials from `POST rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/
generate-ice-servers` (TTL 3600s). NOTE: TURN key id + TURN API token are a SEPARATE credential
pair from the SFU app id/secret — both provisioned in S7.1, both stored per R7. BUNDLE max-bundle.

### 7.2 Presets, bitrate & simulcast — the exact numeric tables live in §App-D

Screen shares and webcams publish **two simulcast layers** (`h` = the chosen preset, `l` = the
pinned low layer) via `addTransceiver(track, { direction:'sendonly', sendEncodings:[{rid:'h',…},
{rid:'l', scaleResolutionDownBy,…}] })`. Watchers: every watched tile → `h` from the initial pull
(FR-33 amended — `tracks/update` stays as the unused downswitch mechanism), voice-only users →
nothing (FR-30). Publisher preset changes (FR-27)
= `applyConstraints` on the capture track (frame-rate ceiling only) + `RTCRtpSender.setParameters`
(maxBitrate/maxFramerate/scaleResolutionDownBy on both rids) — never re-create the track. Amended
S12.4: RESOLUTION is owned by the encoder scales computed from the acquisition height — a
width/height `applyConstraints` on a display-capture track resolves but silently keeps delivering
acquisition-size frames on some platforms (nightly probe: linux headless), which stranded the `h`
layer at the old resolution; capture geometry is therefore FIXED at acquisition for the share's
lifetime.
`getDisplayMedia` constraint rules (Chromium, pinned): only `ideal`/`max` are legal (`min`/`exact`
throw TypeError); `width`/`height` act as downscale-only maxima; fps above the source refresh or on
static content silently drops — the preset is a ceiling, not a guarantee, and tests assert `≤`.
Every encoding sets `maxBitrate` from §App-D — **mandatory**: unbounded layers break both the
simulcast layer selection and the cost model (verified behavior: high layer above the viewer's
bandwidth estimate silently forces everyone to the low layer).

### 7.3 Audio graph (one `AudioContext`, module `app/src/media/audioGraph.ts`)

```
remote mic tracks ──► MediaStreamSource ─► userGain[uid] ─┐        (each remote track ALSO attaches
stream audio tracks ─► MediaStreamSource ─► streamGain[t] ─┼─► deafenGain ─► masterGain ─► ctx.destination
soundboard buffers ──► BufferSource ─► trim ─► sbGain ─────┘                    (sink = chosen output device)
local mic ─► Analyser (speaking meter, never routed to output)
```

Pinned mechanics:
- `new AudioContext({ sampleRate: 48000 })` (matches Opus; avoids device-rate resample edges), ONE
  per app; `ctx.resume()` on the voice-join click (autoplay policy leaves it `suspended` — a
  suspended context = silent meters/recording/soundboard).
- Chromium bug 40094084 (open, verified 2026-07): a remote WebRTC track feeding only WebAudio
  renders SILENCE — every remote `MediaStream` is ALSO attached to a muted playing `<audio>`
  element, unconditionally.
- Output routing: `AudioContext.setSinkId(deviceId)` (Chromium 110+). In Electron this requires the
  main process to allow BOTH `media` and `speaker-selection` in `setPermissionRequestHandler` AND
  `setPermissionCheckHandler` (S4.1) — rejecting `media` in the check handler also breaks
  `enumerateDevices` labels (electron#42713).
- Deafen = `deafenGain.gain = 0`. Sliders 0–200% map to gain 0–2 (GainNode is why we don't use
  `element.volume` — it caps at 1.0), persisted in localStorage (`settings.volumes.v1` schema in
  shared).

### 7.4 Soundboard playback (FR-36) & recording (FR-25)

Soundboard: on `sound.played` broadcast, each in-voice client fetches the mp3 via
`/api/media/*` (Cache API-backed), `decodeAudioData`, plays the `[trimStart,trimEnd]` slice via
`AudioBufferSourceNode.start(0, offset, duration)` through `sbGain` (trim is metadata-only — the
browser has no mp3 encoder and none is needed). Decoded buffers are NOT cached (5 min stereo
48 kHz ≈ 110 MB each) — decode per play, release after. The DO stamps the play event; stats
update via the same broadcast.

Recording: recorder client builds a parallel mix (all `userGain` sources pre-deafen + own mic +
the soundboard tap — the recording captures the call as heard, pinned) into
a `MediaStreamAudioDestinationNode` → `MediaRecorder('audio/webm;codecs=opus')` with
`start(LIMITS.recordingTimesliceMs)`. Chunks are only valid concatenated in order (WebM header
lives at the front — W3C-guaranteed concatenation, nothing else); the client accumulates them into
fixed-size parts of `LIMITS.recordingPartBytes` (R2 multipart requires equal-size non-final parts,
min 5 MiB) and uploads each as it fills; stop → upload tail part → complete. Pinned ceilings: a
crash loses at most the unfinished part; recorded WebM lacks duration/cues (crbug 642012) so the
player shows metadata duration and seeking is best-effort — no remux in v1. Recorder leaving
voice = auto-stop + finalize. REC state machine lives in the DO (single active recording per
server; second `rec.start` → `error{code:'already_recording'}`).

### 7.5 Canvas layout — exact table in §App-C (locked to `images/`)

### 7.6 Shell layout (from `images/main layout.png`) & routes

Grid: header (full width, 40px) / left column 240px = Channels (top) + People (fill) / center =
Canvas (fill) + Controls bar (56px) / right column 320px = tabs Chat·Activity·Stats·Recordings
(top, fill) + Soundboard (bottom, 280px). Header holds: server switcher dropdown (joined servers +
Join/Create), connection status dot, user menu (settings, logout — profile editing lives inside Settings).
Controls bar:
join/leave voice, self-mute, deafen, screen share, webcam, record, voice timer chip.
Routes: `/login` `/register` `/join` (first-run server join/create) `/s/:serverId`. Desktop uses
hash history (file:// origin), web uses browser history — pinned in `router.tsx`.

---

## §8 — Cost guardrails & kill switch (day-one requirements, NOT optional polish)

The SFU bills egress ($0.05/GB after 1 TB/mo free — the free tier is SHARED between SFU and TURN;
ingress free; verified on developers.cloudflare.com/realtime/pricing 2026-07-09). Uncapped worst
case for this product shape is $600+/mo; capped it is ~free. Therefore:

- **G1 Demand-driven media only**: nothing is pulled without explicit user intent (voice join /
  watch click). Enforced client-side AND rejected server-side (Worker refuses pulls of tracks the
  DO doesn't map to an active voice membership / watch grant).
- **G2 maxBitrate on every encoding** per §App-D. Missing maxBitrate = review-blocking bug.
- **G3 Simulcast mandatory** for screen+webcam; every watcher pulls `h` (FR-33 amended — the `l`
  layer stays published for a future data-saver toggle).
- **G4 Concurrent screen-share cap**: `LIMITS.maxConcurrentScreenShares = 4` per server; 5th
  `stream.start` → `error{code:'share_cap'}`.
- **G5 Egress meter**: DO accumulates estimated egress (Σ active pulls × §App-D bitrate × dt,
  computed on watch start/stop/tick) into `egress_log`. At `LIMITS.egressWarnGB=700`/month →
  `cost.warning` broadcast (UI banner). At `LIMITS.egressKillGB=900` → new pulls rejected
  (`cost_cap`), voice stays up. Env override `KILL_SWITCH_DISABLED=1` for emergencies.
- **G6 Free-tier awareness**: within 1TB/mo everything is $0; the meter exists so the group
  *knows* before money happens.

---

## §9 — Code quality & conventions (binding for every line of code)

- **9.1 TypeScript strict**; no `any`, no `as` casts except `as const` and test doubles; no
  non-null `!` (use invariant helpers). `@ts-expect-error`/`eslint-disable-next-line` allowed ONLY
  with a comment naming the upstream issue, max 1 per file (lint-enforced).
- **9.2 Single-purpose modules.** A component renders; a hook orchestrates; a store owns state; a
  module in `media/`/`lib/` does I/O or computation. Components ≤150 lines, hooks ≤100, modules
  ≤300 — hitting the cap means splitting by responsibility, not extracting `utils2.ts`.
- **9.3 Naming**: PascalCase components (one exported component per file), `useX` hooks,
  camelCase functions, UPPER_SNAKE constants only inside `limits.ts`/`presets.ts`. No default
  exports anywhere (router lazy imports use named exports too).
- **9.4 No barrels** except each package's single entry `index.ts`. Imports use `@tavern/*` across
  packages and relative paths inside a package.
- **9.5 Errors**: never swallow. Worker/DO: typed `ErrorCode` responses. Renderer: TanStack Query
  `onError` → toast with i18n-mapped code; WS/media failures set typed store status fields that UI
  renders (`reconnecting`, `media-failed`, …). `console.error` allowed only in `catch` blocks that
  also surface the error to UI or telemetry.
- **9.6 i18n (Paraglide)**: user-visible string literals in JSX are forbidden — enforced by
  `scripts/check-i18n-literals.mjs` (parses `app/src/**/*.tsx` with `oxc-parser`, fails CI on any
  JSXText / user-facing JSX-attribute string containing letters, minus an explicit allowlist file;
  written in S4.2). Message keys are FLAT snake_case (`chat_composer_placeholder`) — never nested,
  never bracket-accessed (`m["a.b"]` is forbidden; it defeats tree-shaking and go-to-definition).
  **Mechanical mapping rule:** any dotted i18n key written in a step file (e.g.
  `activity.voiceJoin`) is implemented as its snake_case form (`activity_voice_join`) — this is a
  rename, not a decision. `messages/en.json` and `messages/uk.json` must have identical key sets
  (unit test in S4.2 enforces). All message access via `m.*()` from the generated
  `@/paraglide/messages.js`; no dynamic key construction.
- **9.7 Comments** explain constraints only ("SFU offers on pull — answerer side"), never restate
  code. Every deliberate simplification carries the pinned reason.
- **9.8 Boundary validation** (A9): any data crossing HTTP/WS/IPC/storage is parsed with the
  shared zod schema at the receiving side. Internal call sites trust types.
- **9.9 React**: function components only; state via zustand selectors (no prop-drilling chains
  >2); effects only for real external sync (WS, media, focus) — derived state is computed, not
  effected; lists get stable keys (ids, never index).
- **9.10 Formatting/lint**: oxlint 1.73.0 (`oxlint --deny-warnings` at root, one `.oxlintrc.json`)
  + oxfmt 0.58.0 (`oxfmt --check`, config `.oxfmtrc.json`) — zero diagnostics policy. Suppressions
  follow the 9.1 rule (`// oxlint-disable-next-line <rule> -- <upstream reason>`, max 1/file).
- **9.11 Dependency discipline**: §3 is the complete dependency list. R2 applies.

---

## §10 — Testing policy

| Layer | Runner | Scope & rules |
|---|---|---|
| Unit | Vitest 4.1.10 (jsdom for DOM) | `shared` (schemas round-trip, layout table, presets math), `app/media/*` + stores (WebRTC/WebAudio mocked behind thin interfaces), worker pure logic (mention parser, cost math). Fast, no I/O. |
| Integration (worker) | Vitest + `@cloudflare/vitest-pool-workers` (`cloudflareTest()` plugin config) | Real local bindings (D1 via `applyD1Migrations`, R2, DO with SQLite via `runInDurableObject`/`runDurableObjectAlarm`): full HTTP flows (auth→create server→join), WS flows against the real DO (ticket→hello→chat→broadcast), RTC proxy with the SFU HTTP API mocked via fetch-mock fixtures (recorded shapes from §7.1). **WS+DO tests live in a dedicated vitest project run with `--max-workers=1 --no-isolate`** (per-file storage isolation doesn't support DO WebSockets — official known issue). |
| Integration (renderer) | Vitest + RTL 16.3.2 + jsdom | Feature-level: render feature with mocked `lib/` seams; forms (RHF+zod) validate/submit; boot gate state machine. |
| IPC contract | Vitest | preload & web bridge both satisfy `shared/ipc.ts` schemas (compile-time + runtime fixtures). |
| E2E | Playwright 1.61.1 | Real `wrangler dev` stack (Playwright `webServer: { command: 'wrangler dev', url: 'http://localhost:8787' }`) + built app. Web: chromium, **two browser contexts = the default multi-client topology**. Desktop: `_electron.launch` (experimental — pinned patterns below). Two-client scenarios: chat, voice, watch, soundboard, recording, kick. |
| E2E (nightly/main only) | Playwright | Full media assertions against REAL Cloudflare Realtime (secrets in CI): remote `getStats` bytes/audioLevel/frames, simulcast layer switches. |

Hermeticity split (pinned): PR e2e runs with `TAVERN_SFU_MOCK=1` — the Worker's realtime client is
swapped for a fixture-backed mock (valid response shapes, no media plane). PR suites therefore
assert **signaling + state + local media** (voice.state fan-out, watch grants, pull-session
creation via test hooks, speaking ring from the LOCAL analyser on the fake tone). Assertions that
need remote media (bytesReceived, framesDecoded, layer switches) are tagged `@realtime` and run
only in nightly/main against the real SFU. A PR may not add an `@realtime`-only feature without a
state-level PR assertion too.

Electron e2e pinned patterns (each is a researched trap, not a preference):
- Fake media flags do NOT work via `launch({ args })` (playwright#16621). The desktop main process
  applies `app.commandLine.appendSwitch('use-fake-device-for-media-stream')` +
  `('use-file-for-fake-audio-capture', <tone WAV path>)` itself when `TAVERN_E2E=1`, passed via
  `_electron.launch({ env })`; permission auto-grant via `setPermissionRequestHandler` in the same
  mode (`--use-fake-ui` is a no-op in Electron). The tone WAV (generated fixture, committed) is
  required because the default fake-device beeps never satisfy the §App-B speaking threshold.
- Two desktop instances: distinct `userData` dirs via env + single-instance lock skipped when
  `TAVERN_E2E=1`.
- Packaged-app e2e requires the `nodeCliInspect` fuse LEFT ON — production hardening must not flip
  `FuseV1Options.EnableNodeCliInspectArguments` to false in the e2e-tested artifact (S12.1 keeps
  it on everywhere in v1; revisit only with a blocker).
- Coverage: istanbul provider everywhere (V8 coverage is rejected inside workerd; one provider =
  one merged report). The worker's serial WS project is EXCLUDED from the coverage gate (shared
  storage, serial run); the default worker project owns the ≥80% gate.

Numeric gates (CI-enforced, lowering = R4 violation): line coverage `shared ≥90%`,
`worker ≥80%`, `app ≥70%` (`app/src/media ≥85%`), `desktop ≥70%`. Every FR id appears in ≥1
`describe()` string across the repo (checked by a grep script in CI — the traceability gate).

Test naming: `describe('FR-27 screen share presets', …)`. Fixtures in `e2e/harness/` (user
factory, server factory, fake-media WAV/Y4M generation script — committed, not generated at test
time).

---

## §11 — CI/CD & release (GitHub Actions)

- **`ci.yml`** (every PR + push to feat/electron or main): install (pnpm, frozen lockfile) → lint +
  typecheck (all packages) → unit+integration (shared, worker, app, desktop) → build all →
  coverage gates + FR-traceability grep → e2e-web (ubuntu, wrangler dev + chromium, mocked SFU) →
  e2e-desktop (ubuntu + xvfb, Electron, mocked SFU). On pushes to `main` ONLY, an additional
  `package-check` job (added in S12.1) runs the electron-builder matrix on all 3 OSes
  (unsigned, `--publish never`) — every commit to main proves every desktop platform still
  packages before anything deploys.
- **`nightly.yml`** (CREATED in S12.2, extended with the soak job in S12.3; triggers:
  `schedule` + `workflow_dispatch`): full e2e against real Realtime (`@realtime` project) + real
  deployed preview; 3-OS Electron boot-smoke matrix (launch packaged app, assert window title,
  quit) incl. Void-Linux AND Ubuntu-24.04 container jobs for the AppImage.
- **`release.yml`** (tag `v*`): 3-OS electron-builder matrix (`npx electron-builder --publish
  always`, `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, `permissions: contents: write`) → sign/notarize
  macOS (`notarize: true` + `hardenedRuntime` + entitlements plists; secrets: CSC_LINK,
  CSC_KEY_PASSWORD + the Apple API-key trio APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER), NSIS
  win, AppImage linux (static-runtime toolset). electron-builder uploads to a **DRAFT** GitHub
  release — the final pipeline step publishes the draft, otherwise updaters never see it. macOS
  MUST keep both dmg+zip targets (zip is what Squirrel.Mac updates from; without it
  latest-mac.yml isn't generated).
- **`deploy.yml`** (created in S12.2; triggers via `workflow_run` when `ci` concludes green on
  `main`): build web assets (shared + app — the worker serves `../app/dist`; deploying without
  them fails) → account guard → `wrangler d1 migrations apply tavern-db --remote` →
  `wrangler deploy`. Steady state once v1 lands on main: **commit to main → all gates +
  3-OS package checks → D1 migrations → web live on Cloudflare, zero human steps.** Desktop
  artifacts stay tag-driven (`release.yml`) because auto-update requires versioned GitHub
  Releases. Account: Roman's personal CF account `fd8a5f7a38f28a2cd11e79e85985c7d4`, worker name
  `tavern`, hard-pinned via `account_id` in `wrangler.jsonc` — NEVER the Icelook account.
- Windows builds are unsigned in v1 (SmartScreen warning accepted — pinned decision; NSIS
  auto-update works unsigned). Known consequence, accepted now: signing later with a new cert
  breaks electron-updater's publisherName check for apps installed from unsigned builds — those
  users reinstall once. If Apple Developer ID secrets are absent at S12.2, §3.7's fallback applies
  (electron-updater hard-requires signed builds on macOS — do not work around).
- AppImage updater only runs when the `APPIMAGE` env var exists (set by the AppImage runtime) —
  updater init is guarded so dev builds and NSIS/mac builds each use their own path.
- Nightly Linux matrix includes BOTH a Void container job AND an Ubuntu 24.04 job (its
  `apparmor_restrict_unprivileged_userns=1` can break Chromium's sandbox for AppImages — boot
  smoke catches it).

---

## §12 — Step index & dependency graph

Steps live in `docs/steps/`. `⇒` = `after:` dependency. Two parallel tracks converge at S5.

```
S0.1 repo bootstrap ⇒ S0.2 shared package (protocol/limits/layout/presets) ⇒ S0.3 CI skeleton
BACKEND TRACK                                 CLIENT TRACK
S1.1 worker bootstrap (Hono+bindings+pool)    S4.1 electron shell (main/preload/IPC/security)
S1.2 BetterAuth (register/login/bearer)       S4.2 app bootstrap (vite/tailwind/shadcn/i18n/theme/router)
S1.3 profile+settings+avatar endpoints        S4.3 boot gate + platform bridge + stores skeleton
S2.1 servers create/join/list + channels      S4.4 playwright harness (web+electron smoke) [also after S1.1 — webServer needs the worker health route]
S3.1 ServerRoom DO: WS+ticket+presence
S3.2 chat + mentions + history
S3.3 activity log
S3.4 voice state + timer + alarm
S2.2 admin ops (rename/password/kick)  [after S3.1, S3.3 — kick writes an activity entry]
                    └──────────────┬──────────────┘
S5.1 auth screens + session flow [after S1.3, S4.4]
S5.2 server join/create/switch UI [after S2.1, S5.1]
S6.1 chat UI + emoji + mentions [after S3.2, S5.2]
S6.2 notifications + settings UI [after S6.1]
S7.1 RTC proxy + ICE + cost meter [after S3.4]
S7.2 media engine: publish/pull/audio graph (unit-level) [after S0.2]
S7.3 voice UI: join/leave/devices/volumes/speaking/mute/deafen [after S7.1, S7.2, S5.2]
S7.4 voice e2e (2-client, fake media) [after S7.3]
S8.1 screen share publish (picker/presets/loopback/simulcast) [after S7.3]
S8.2 watch/unwatch + canvas + auto-layout + focus/fullscreen [after S8.1]
S8.3 webcam publish [after S8.2]
S8.4 on-the-fly preset switch + watch-stats heartbeat [after S8.2]
S8.5 streams e2e [after S8.3, S8.4]
S9.1 soundboard upload/trim/manage [after S5.2]
S9.2 soundboard playback + stats + volume [after S9.1, S7.3]
S9.3 voice recording + playback UI [after S7.3]
S10.1 activity tab [after S3.3, S6.1]   S10.2 stats tab [after S8.4, S6.1]   S10.3 admin UI [after S2.2, S5.2, S7.3]
S11.1 web target: worker assets + parity + refresh-gate e2e [after S6.2, S8.5]
S12.1 packaging (builder config, icons) [after S8.5]
S12.2 auto-update + release pipeline [after S12.1]
S12.3 cost kill-switch verification + 10-client soak script [after S8.5, S9.2, S12.2 — modifies nightly.yml]
S12.4 full regression matrix + docs close-out [after ALL]
```

---

## §13 — Traceability matrix (FR → primary steps)

| FR | Steps | | FR | Steps |
|---|---|---|---|---|
| FR-01,02 | S1.2, S5.1 | | FR-24 | S3.4, S7.3 |
| FR-03,04 | S1.3, S6.2 | | FR-25 | S9.3 |
| FR-05 | S1.3, S6.2 | | FR-26 | S7.3 |
| FR-06 | S4.2, S6.2 | | FR-27 | S8.1, S8.4 |
| FR-07 | S4.2, S6.2 | | FR-28 | S8.1 |
| FR-08,09 | S2.1, S5.2 | | FR-29 | S8.3 |
| FR-10,11,12 | S2.2, S10.3 | | FR-30,31 | S8.2 |
| FR-13 | S2.1 | | FR-32 | S0.2, S8.2 |
| FR-14 | S3.2, S6.1 | | FR-33 | S8.2, S8.4 |
| FR-15 | S3.2, S6.1 | | FR-34,35 | S9.1 |
| FR-16 | S6.2 | | FR-36,37,38 | S9.2 |
| FR-17 | S3.2 | | FR-39 | S3.3, S10.1 |
| FR-18,19 | S3.4, S7.1–S7.4 | | FR-40 | S3.4→stats, S8.4, S10.2 |
| FR-20 | S7.3 | | FR-41 | S5.2 |
| FR-21 | S7.3 | | FR-42 | S11.1 |
| FR-22 | S7.3 | | FR-43 | S4.3, S11.1 |
| FR-23 | S7.2, S7.3 | | FR-44 | S12.2 |
| | | | FR-45 | S3.1, S5.2 |

S12.4's DoD includes re-verifying this matrix: every FR's AC demonstrated by a named green test.

---

## §14 — Risk register (pre-answered so implementers don't improvise)

| Risk | Pinned answer |
|---|---|
| Realtime SFU API shape drifts from §7 | STOP + blocker; fixtures in worker tests document the expected shapes — update only via human-approved blocker resolution. |
| macOS signing secrets unavailable | §3.7 fallback: unsigned mac build, auto-update disabled on mac, blocker filed. |
| Loopback audio behaves differently than researched on some OS | `capture.loopbackAudioSupported()` gates the UI per-OS; macOS probe failure path pre-authorized in §3.7; worst case an OS ships FR-28 video-only + informational blocker. |
| Bleeding-edge toolchain picks (TS 7.0, oxfmt beta) misbehave | §3.7 rows pin the exact fallback (TS 5.9.3 / prettier 3.9.5) — execute, don't deliberate. |
| Fake-media e2e flakiness | Pinned harness rules (§10): tone-WAV fixture, generous-but-bounded waits, retry=1 in CI for e2e only; a test needing retry>1 is a bug to fix, not to hide. |
| `wrangler dev` instability under rebuilds | Known: restart wrangler after each `vite build` in e2e harness (do not rely on hot reload). |
| DO SQLite growth | Bounded by product shape (10 users); no pruning in v1 (pinned non-goal), `messages` paginated reads only. |
| Electron/Chromium updates breaking media | Versions pinned (§3); upgrades are their own future step with the full e2e matrix as the gate. |

---

# Appendices

## App-A — WS message catalog (implemented as zod discriminated unions in `shared/src/protocol.ts`)

All frames: `{ t: string, ...payload }`. Server→client frames that mutate shared state also carry
`at` (epoch ms). Ids: `userId`/`serverId` = UUID strings; `messageId`/`activityId` = integers.
Frames carry NO `serverId` — each WS connection IS a server scope; the client's wsClient tags
every inbound event with its connection's serverId before it reaches stores (notifications etc.).

**Client → Server** (15 message types):

| `t` | payload | notes |
|---|---|---|
| `hello` | `{ proto: 1 }` | first frame within 5s of open (auth already done via ticket) |
| `chat.send` | `{ body, nonce }` | body 1..2000; nonce echoes back for optimistic UI |
| `chat.history` | `{ beforeId?, limit≤50 }` | reply: `chat.page` |
| `voice.join` | `{}` | one-voice-at-a-time is CLIENT-enforced (leave-then-join confirm); a DO cannot see other rooms and never emits `voice_elsewhere` |
| `voice.leave` | `{}` | |
| `voice.state` | `{ muted, deafened }` | self flags (FR-26) |
| `stream.start` | `{ kind:'screen'\|'webcam', trackName, audioTrackName?, preset }` | after successful publish; DO validates caps (G4) + naming (§7.1) |
| `stream.preset` | `{ trackName, preset }` | publisher changed preset on the fly (FR-27) — keeps the DO registry + cost meter (G5) accurate |
| `stream.stop` | `{ trackName }` | |
| `watch.start` | `{ trackName }` | grants the pull (G1) + starts watch-stat clock |
| `watch.stop` | `{ trackName }` | |
| `sound.play` | `{ soundId }` | rate-limited (§App-B) |
| `rec.start` / `rec.stop` | `{}` / `{}` | WS flips `rec.state` immediately; the recording ROW finalizes via REST `complete` (durationMs). Dirty disconnect of the recorder = cancel: row deleted, R2 multipart aborted by the DO, activity `rec.stop meta:{aborted:true}` |
| `ping` | `{}` | reply `pong`; client sends every 30s |

**Server → Client** (20 message types): `hello.ok { self, serverMeta{ id,nickname,adminUserId }, members:Member[],
voice:VoiceState, streams:StreamInfo[], recording:RecordingState, lastMessageId, costStatus }` ·
`error { code, ref? }` · `pong` · `presence.update { userId, presence }` ·
`member.update { profile }` · `member.joined { member }` · `member.left { userId }` ·
`chat.new { message{ id,userId,body,mentions,at }, nonce? }` · `chat.page { messages[], hasMore }` ·
`voice.state { VoiceState }` (full snapshot on every change — 10 users, snapshots are cheap and
race-free; ALSO broadcast when a member's mic track (re)registers, carrying their bumped
`micSeq` — the "mic is now pullable" signal that closes the join-time publish race and re-pulls
stale mic sessions) · `stream.added { StreamInfo }` · `stream.updated { trackName, preset }` ·
`stream.removed { trackName }` ·
`sound.played { soundId, byUserId }` · `sound.updated { }` (list refetch signal) ·
`rec.state { recording: RecordingState, at }` · `activity.new { entry }` ·
`server.updated { nickname, at }` · `kicked { at }` (then close 4001) ·
`cost.warning { usedGB, capGB, at }`
(The `at` fields follow this appendix's preamble rule — a step file or S0.2 showing `at` where
this table's older prose omitted it is NOT a conflict.)

`activity.types` enum: `voice.join · voice.leave · stream.start · stream.stop · rec.start ·
rec.stop · member.join · member.kick`.

Close codes: 1008 protocol violation · 4001 kicked · 4002 ticket invalid · 4003 replaced by newer
connection from same device.

## App-B — `shared/src/limits.ts` (complete constant set; single source for every magic number)

```
username: /^[a-z0-9_]{3,20}$/ (stored lowercase) · displayName 1..32 · password ≥8
serverNickname: /^[a-z0-9-]{3,32}$/i unique NOCASE · serverPassword ≥4 (optional)
color: /^#[0-9a-f]{6}$/ · avatarMaxBytes 2_000_000 · avatar 256×256 webp
message ≤2000 chars · historyPageSize 50
soundMaxBytes 10_000_000 · soundMaxDurationMs 300_000 · soundMinTrimMs 200 · soundNameLen 1..32
recordingMaxDurationMs 14_400_000 (4h) · recordingTimesliceMs 10_000 · recordingPartBytes 5_242_880 (R2 multipart min/equal part size)
maxConcurrentScreenShares 4 · maxServersPerUser 20 · maxMembersPerServer 25 (ENFORCED at join:
count ≥ cap → error `server_full`; product shape is 10, cap leaves headroom)
speakingRmsThreshold 0.02 sustained ≥100ms · speakingHangoverMs 300
wsTicketTtlMs 30_000 · helloTimeoutMs 5_000 · pingIntervalMs 30_000 · reconnectCapMs 30_000
emptyVoiceCloseMs 60_000 (alarm)
rate limits: authPerIpPerMin 10 · chatPerUser 5/s burst 10 · soundPlayPerUser 1/s ·
             uploadsPerUserPerHour 10 · rtcOpsPerUserPerMin 60
egressWarnGB 700 · egressKillGB 900 (per month, per §8)
```

## App-C — Canvas auto-layout (locked to `images/*.png`; implemented once in `shared/src/layout.ts`)

Input: `n` = tile count, canvas `w×h`. Output: rows of tile counts, top→bottom. Tiles are 16:9,
letterboxed inside their cell, 8px gap.

| n | rows | source |
|---|---|---|
| 1 | [1] | 1.png |
| 2 | [2] if fitted-tile-area(side-by-side) ≥ fitted-tile-area(stacked), else [1,1] | 2h.png / 2v.png — deterministic area comparison, ties → side-by-side |
| 3 | [2,1] | 3.png (bottom tile full width) |
| 4 | [2,2] | 4.png |
| 5 | [2,3] | 5.png |
| 6 | [3,3] | 6.png |
| 7 | [4,3] | 7.png |
| 8 | [4,4] | 8.png |
| 9–12 | [3,3,3] · [4,3,3] · [4,4,3] · [4,4,4] | extrapolated rule, pinned |

`fitted-tile-area(w,h) = min(w, h·16/9) · min(h, w·9/16)` per cell. Unit tests lock all 12 rows +
the n=2 tie-break at 3 canvas aspect ratios (§10 traceability: FR-32).
Derived (do not re-litigate): side-by-side wins exactly when canvas aspect > 16:9. Inside the
standard shell on a 1920×1080 window the canvas is ~1.38:1, so two streams STACK ([1,1]) — that is
intended (2v.png sanctions it; area-max beats the task.md prose); side-by-side appears on wide
canvases (ultrawide, collapsed panels, fullscreen canvas).

## App-D — Stream presets & simulcast bitrates (`shared/src/presets.ts`)

High layer (`h`) = selected preset. Every encoding carries `maxBitrate` (kbps) and `maxFramerate`:

| preset | 15 fps | 30 fps | 60 fps |
|---|---|---|---|
| 480p (854×480) | 400 | 800 | 1200 |
| 720p (1280×720) | 700 | 1800 | 3000 |
| 1080p (1920×1080) | 1200 | 3500 | 6000 |
| 1440p (2560×1440) | 1800 | 5000 | 9000 |

(30/60fps caps re-anchored 2026-07-11: streams are usually motion — the original caps starved a
1080p60 share to ~0.02 bits/pixel, unreadable blur. 15fps rows unchanged; data tiers remain the
cost knob. Watcher pulls PIN their layer at the SFU — `priorityOrdering:"none"` — because the SFU's
automatic mode bounced fullscreen watchers back to the 270p l layer on every BWE dip.)

Low layer (`l`, always): `scaleResolutionDownBy` → height ≈270, 15fps, 250 kbps.
Webcam: fixed 720p30 h-layer 1000 kbps + l-layer 180p/15fps/150 kbps.
Default screen preset: 1080p30. Voice: browser Opus defaults (no overrides in v1).
Egress cost math in `costMeter.ts` uses THESE numbers (bytes = kbps·dt/8) — one table, two uses.
