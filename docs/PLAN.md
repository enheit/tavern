# Tavern — Implementation Plan v1.1

v1.1: all findings from the 3-lens adversarial audit folded in (determinism, DoD
runnability, feasibility). Single-path media signaling; WS auth via query token; full
bitrate tables; production deployment step added; test-tooling pins corrected.

This document is the **single source of truth** for implementing Tavern. The implementer
executes steps **strictly in order**, one at a time. A step is complete ONLY when every
item in its **DoD** (Definition of Done) passes — DoD items are runnable tests or
measurements with numeric gates, never judgment calls. Evidence (test output, JSON
reports) is logged per step in `docs/progress.md`.

**The implementer makes no design decisions.** Everything is pre-decided here. If a step
cannot meet its DoD, or reality contradicts this plan (API mismatch, crate broken), the
implementer STOPS, writes `docs/blockers.md` (step id, what was attempted, exact errors,
evidence), and halts for the user. The only permitted deviations are the explicitly
labeled **FALLBACK** branches, taken in the order written.

---

## 0. Product scope (fixed)

Tavern is a desktop voice/screen-share app for friends. Scale: 1–5 servers, ≤10 users
each. Performance and correctness over UI polish. Primitive, clean UI. Light/dark theme
following the OS.

**IN scope v1:**
- Registration: nickname + password + repeat → permanent account. Login. Logout. No email/OAuth.
- Servers (private; joined by server-ID + optional password; owner creates). Server switcher.
- Channels per server: text + voice, each with optional password (asked once, remembered).
- Text chat per text-channel: plain messages, history pagination (50/page), member list.
- Presence: `offline` (no connection) / `online` (app open, connected) / `voice` (in a voice channel).
- Voice: join/leave, mute mic, deafen (mute mic + silence all output), per-user volume (0–200%, personal), speaking indicators.
- Screen share: source picker, resolution (native/360/480/720/1080/1440) + fps (15/30/60/120) selection, ≤3 simultaneous shares per channel.
- Webcam: on/off, 360/480/720 at 15/30 fps.
- Watching streams: **manual** join per stream, leave, watch multiple at once; one "pinned" (high quality) stream at a time, others low quality.
- Profile: change nickname, nickname color, avatar (image ≤512 KB).
- Cost guards: account-wide egress budget with soft/hard caps.
- Auto-updater (static manifest on R2 via Worker route).

**OUT of scope v1 (do not build, do not stub):** DMs, notifications, message edit/delete,
attachments, reactions, stream *system audio* (screen shares are video-only; voice comes
from mics), E2EE, mobile, server discovery, roles beyond owner/member, message search,
channel reordering UI.

---

## 1. Fixed global decisions

| Decision | Value |
|---|---|
| Cloudflare account | `fd8a5f7a38f28a2cd11e79e85985c7d4` (roman.mahotskyi@gmail.com). **Never** any other account. |
| Cloud resources allowed | Realtime SFU app `tavern-sfu`, D1 `tavern-db`, R2 buckets `tavern-avatars` + `tavern-updates`, Worker `tavern`. Nothing else without user approval. TURN: NOT provisioned; see S1.3. |
| Repo layout | `app/` (Svelte 5 + Vite), `worker/` (Worker + DO, TypeScript), `src-tauri/` (Tauri app crate), `crates/engine`, `crates/capture`, `crates/protocol`, `spikes/`, `docs/` |
| Package manager | pnpm, pinned via `packageManager` field in root `package.json` (latest pnpm 9.x at scaffold; record exact). Workspaces: `app`, `worker`. |
| Node | 22 LTS (engines field + `.nvmrc`). |
| Rust | Pin current stable at scaffold time in `rust-toolchain.toml` (run `rustup show`, record exact version in progress.md). Workspace `Cargo.toml` at repo root; members: `src-tauri`, `crates/*`, `spikes/*`. |
| Frontend | Svelte 5 (runes) + Vite. TypeScript strict. Plain CSS with custom-property tokens; no CSS framework. |
| Worker deps | hono (latest 4.x, pin exact) · zod (latest 3.x, pin exact). |
| Test stack (JS) | `vitest` `^4.1.0` + `@cloudflare/vitest-pool-workers` `^0.18` (≥0.16.20 required for `evictDurableObject`) + `@vitest/coverage-istanbul` (matching 4.x) + `vitest-browser-svelte` (latest, pin) + Playwright chromium. Record exact versions. Worker Vitest project MUST set `poolOptions.workers: { singleWorker: true, isolatedStorage: false }` (WS + DO tests are unsupported with per-file isolation). Consequence rule: every test creates its own users/servers/channels with `crypto.randomUUID()`-derived names; no test asserts global table counts. |
| Coverage | Provider `istanbul` in BOTH Vitest projects (V8 coverage unavailable in workerd). Gates: worker lines ≥85%, app lines ≥70%, Rust crates ≥70% via `cargo llvm-cov` (ubuntu CI job only). **FALLBACK** (only if pool-workers cannot emit coverage, verified in S0.3): pure-logic modules (`worker/src/lib/**`) get a plain-node Vitest project with lines ≥85%; DO/route code gated by test-count DoDs; record branch. |
| Rust deps (engine side) | `libwebrtc = 0.3.38` exactly (bump ONLY if it fails to build; record). rustflags from livekit/rust-sdks README go in `.cargo/config.toml`. `tokio` 1.x, `reqwest` 0.12 (rustls-tls, no default features), `serde`/`serde_json`, `uuid` (v4), `ts-rs` latest (pin). Capture: macOS `screencapturekit` 8.x · Windows `windows-capture` latest · Linux `ashpd` + `pipewire` · webcam `nokhwa` 0.10.x. Audio out `cpal` latest. Pin exact versions at first use, record. |
| Tauri plugins | `tauri-plugin-keyring` (HuakunShen fork, latest, pin) · `tauri-plugin-store` (non-secret prefs only) · `tauri-plugin-updater`. |
| Audio I/O | S1.6 decides **capture only**: libwebrtc ADM if its round-trip gates pass, else `cpal` capture. **Remote playout is ALWAYS engine-owned in both branches:** per-remote-track AudioStream (pull decoded PCM per track) → engine mixer (per-user gain, deafen master gain, RMS taps) → APM `process_reverse_stream` → `cpal` output stream. APM (AEC+NS+AGC) mandatory in both branches. |
| Video codec | Decided by S1.5 measurement: prefer VP8; if any webview's WebCodecs fails VP8 → H264 (constrained baseline). WebCodecs codec strings: VP8 → `"vp8"`, H264 → `"avc1.42E01F"`, no `description`. Recorded in `docs/spike-results.md`; all later steps use the recorded codec. |
| API base URL | App reads `VITE_API_BASE`: dev `http://localhost:8787`, prod `https://tavern.<workers-subdomain>.workers.dev` (exact URL recorded at S6.0). WS URL derived from it (`http→ws`, `https→wss`). Engine receives it via `engine_configure`. |
| Auth | PBKDF2-SHA-256, 100 000 iterations, 16-byte random salt per credential, WebCrypto `deriveBits` (256-bit), verify via `crypto.subtle.timingSafeEqual`. Session token: 32 random bytes base64url; D1 stores `sha256(token)` hex. Sessions never expire; deleted only by logout. `last_seen_at` informational only. Same hash helper for user/server/channel passwords. |
| Validation limits | Lengths in Unicode code points. nickname `^[A-Za-z0-9_]{2,32}$` (unique, case-insensitive) · password 8–128, any chars · message ≤2000 after trim, non-empty · color `^#[0-9a-fA-F]{6}$` · avatar ≤512 KB, `image/png|jpeg|webp` · server/channel name trimmed, 1–48 after trim. |
| IDs | `crypto.randomUUID()` for users/servers/channels. Message ids: DO SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`. trackName: generated by ENGINE as `{kind}-{uuidv4}`, kind ∈ mic|screen|webcam. |
| Protocol types | Defined once in `crates/protocol` (serde). TS generated with `ts-rs` into `app/src/lib/protocol/` and `worker/src/protocol/`; CI regenerates and fails on `git diff --exit-code`. |
| Time | Unix milliseconds. Budget months keyed by UTC `YYYY-MM`. ServerRoom exposes injectable `nowMs()` (defaults `Date.now`) so tests control time via `runInDurableObject` — never fake timers. |
| Commits | Conventional Commits, one commit per completed step: `feat(scope): S<id> <summary>`. Never commit secrets; `.dev.vars`, `*.key` gitignored from S0.1. |
| CI | `.github/workflows/ci.yml`. Jobs: `web-test` (ubuntu: pnpm lint+test+coverage gates), `rust-test` (matrix ubuntu/windows/macos: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`; ubuntu also `cargo llvm-cov`), `bundle` (matrix, tauri build, upload artifacts). Ubuntu jobs first run: `sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`. Media/capture integration tests are NOT in CI (local/manual, marked per step). |
| Local dev | `pnpm dev:worker` = `wrangler dev` (local Miniflare: DO+D1+R2 on disk) · `pnpm dev:app` = vite · `pnpm tauri dev`. Everything except real SFU calls runs offline. |
| Platform reality | Implementation machine is macOS. macOS runtime gates are HARD. Windows/Linux: code must compile in CI (rust-test matrix); runtime gates are deferred to real hardware and recorded as deferred in `docs/qa/final.md` — never faked, never blocking M2–M6 completion on macOS. |

### Environment & secrets

- `worker/.dev.vars` (gitignored): `CF_APP_ID`, `CF_APP_SECRET` (Realtime SFU).
- Production: `CF_APP_ID` plain var in `wrangler.jsonc`; `wrangler secret put CF_APP_SECRET` (S6.0).
- Budget env vars in `wrangler.jsonc`: `BUDGET_SOFT_GB=800`, `BUDGET_HARD_GB=950` (account-wide; see budget model).
- The Tauri client NEVER holds the SFU secret; all SFU HTTPS calls go through the Worker.
- Spike binaries read `CF_APP_ID` / `CF_APP_SECRET` from process env (spike-only exception).

### Cloudflare Realtime SFU invariants (fixed)

- Base `https://rtc.live.cloudflare.com/v1/apps/{appId}`, `Authorization: Bearer {appSecret}` — called **only** from the Worker.
- One SFU **session = one PeerConnection** per client engine.
- Publishing: client is SDP **offerer**. Pulling: roles reverse — the SFU offers, the client **answers**; handle `requiresImmediateRenegotiation` via the renegotiate endpoint.
- ICE: `stun:stun.cloudflare.com:3478`. STUN-only is the expected outcome (SFU is publicly addressable). If S1.3 finds TURN required → STOP (blocker protocol; TURN provisioning needs user approval).
- Exact request/response field names MUST be taken from `developers.cloudflare.com/realtime/sfu/https-api/` and `cloudflare/calls-examples` at implementation time; the flow/invariants here are fixed. S1.2/S1.3 record the exact JSON shapes used; S2.6 mocks replay those recorded shapes.

### Media signaling — single path (fixed)

There are NO media WS messages from the client. The ServerRoom DO derives the track
registry, watch accounting, and budget from the `/api/rtc/*` calls it authorizes:

- `POST /api/rtc/session {channelId}` → Worker→DO authorize (presence.state=`voice` ∧ presence.channel_id=channelId, else 403) → proxy SFU `sessions/new` → DO records `userId → sfuSessionId` → response `{sfu:{...}}` verbatim.
- `POST /api/rtc/publish {channelId, trackName, kind, width, height, fps, simulcast, sfu:{...}}` → authorize; if `kind=screen` and channel already has 3 active screen tracks → 409 `{code:"share_limit"}`; proxy `tracks/new` (location local); DO registers TrackInfo; broadcast `tracks`.
- `POST /api/rtc/subscribe {channelId, ownerId, trackName, layer:"l"|"h"}` → authorize; resolve `ownerId→sfuSessionId` server-side (clients never see sessionIds); budget checks (below); proxy `tracks/new` (location remote, layer via the rid-selection field recorded in S1.3); start accrual entry keyed `(subscriberUserId, ownerId, trackName)` at the layer's bitrate; response verbatim. For `simulcast:false` tracks the `layer` field is ignored (single encoding pulled); UI disables pin on such tiles.
- `POST /api/rtc/unsubscribe {channelId, ownerId, trackName}` → proxy track close; stop accrual.
- `POST /api/rtc/renegotiate {channelId, sfu:{...}}` → proxy verbatim.
- `POST /api/rtc/unpublish {channelId, trackName}` → proxy close; deregister; broadcast `tracks`.
- `POST /api/rtc/close {channelId}` → proxy session close; clear the user's tracks + subscriptions; broadcast `tracks {ownerId, tracks:[]}`.

Layer change (pin/unpin) = `unsubscribe` then `subscribe` with the new layer (brief tile
blank acceptable). All `/api/rtc/*` calls are made by the ENGINE (reqwest, bearer token
via `engine_configure`); the engine never touches the WS. Mic subscriptions: the UI
forwards every `tracks` roster to the engine via `set_remote_tracks`; the engine diffs
and auto-subscribes `kind:"mic"` (never video) while in voice; video subscribe happens
only via `stream_watch`. Rate limit: 10 `/api/rtc/*` calls/sec/user → 429.

**Budget model (account-wide):** D1 table `budget_usage(month, server_id, est_gb)`.
Each ServerRoom accrues locally (Σ layer-bitrate × wall-time; mic subscriptions accrue at
a fixed 50 kbps) and flushes to its D1 row on the 60 s alarm; level = `SUM(est_gb)` for
the current UTC month vs `BUDGET_SOFT_GB`/`BUDGET_HARD_GB`, evaluated at flush, cached in
the DO. Effects: `soft` → broadcast + (from S6.2) subscribe with `layer:"h"` → 403
`{code:"budget_exceeded"}`; `hard` → any video subscribe → 403; mic subscribe NEVER
blocked. Accrual entries are cleared (finalized) on unsubscribe, `rtc/close`,
`webSocketClose` of the subscriber, and the 75 s stale sweep.

### WebSocket protocol v1 (client ⇄ ServerRoom DO)

Upgrade: `GET /api/servers/:id/ws?token=<token>`. The Worker validates the token hash +
server membership against D1 (401/403 pre-upgrade), then forwards to the DO with header
`X-Tavern-User: <userId>`. The DO reads the header, `acceptWebSocket`,
`serializeAttachment({userId, connId})`, and **immediately sends `hello.ok`**. There is
no client `hello` message. Single-session per user per server: a new connection for a
user with a live connection closes the OLD socket (code 4002, reason `superseded`); a
close event whose connId ≠ presence.conn_id is ignored (no offline broadcast).

JSON text frames `{"v":1,"t":"<type>", ...}`, defined in `crates/protocol`, ts-rs-generated.

Client→Server:
```
chat.send    {channelId, content, nonce}        nonce: client uuid
chat.history {channelId, beforeId|null, limit}  limit ≤ 100
voice.join   {channelId}
voice.leave  {}
heartbeat    {}
```
Server→Client:
```
hello.ok     {userId, roster:[Member], presence:[Presence], tracks:[TrackInfo],
              budget:{level,estMbps,monthGb}}
heartbeat.ok {}
error        {code, msg}   codes: not_member|share_limit|rate_limited|budget_exceeded|invalid|locked
chat.msg     {id, channelId, userId, content, nonce|null, createdAt}
chat.history {channelId, messages:[chat.msg-shaped], hasMore}
presence     {userId, state:"online"|"voice"|"offline", channelId|null}
profile      {userId, nickname, color, avatarKey|null}
tracks       {ownerId, tracks:[TrackInfo]}      full replace per owner
budget       {level:"ok"|"soft"|"hard", estMbps, monthGb}
```
`Member {userId,nickname,color,avatarKey}` · `Presence {userId,state,channelId|null}` ·
`TrackInfo {ownerId, trackName, kind, simulcast, width, height, fps}`.

Semantics (all fixed):
- `heartbeat` every 20 s → server replies `heartbeat.ok`. Client: if no server message for 45 s, force-close and enter backoff. Backoff: exact 1,2,4,8,16,30,30… s, no jitter.
- Presence: `online` written on accept; `voice` on voice.join; `offline` = presence row DELETEd + broadcast (close of current conn or 75 s stale sweep). hello.ok presence contains only online/voice rows.
- `voice.join` on a non-voice or unknown channelId → `error invalid`. voice.join while already in voice in the SAME server = implicit leave+join (both broadcasts). Cross-server single-voice is enforced by the frontend sequence (S4.2).
- Password-locked channels (`pw_hash NOT NULL`): `chat.send`, `chat.history`, `voice.join` require a `channel_access` row (DO checks D1 on first use, caches per connection); violation → `error locked`.
- Nonce dedup: `messages.nonce` column; on `chat.send`, `SELECT id FROM messages WHERE user_id=? AND nonce=? AND created_at > nowMs()-300000`; on hit re-send the existing `chat.msg` to the sender only, no new row. Survives hibernation (it's in SQLite).
- On voice.leave, WS close, or stale sweep: clear the user's track registry, broadcast `tracks {ownerId, tracks:[]}`, finalize their accruals.
- `budget` is re-broadcast on every level change and sent to each new connection inside hello.ok. `estMbps` = Σ bitrate of active subscriptions / 1e6; `monthGb` = account-wide sum at last flush.
- Client resume gap-fill (fixed algorithm): send `chat.history {beforeId:null, limit:50}`; while oldest received id > lastSeenId AND hasMore, repeat with `beforeId = oldest`; cap 4 pages (200 msgs = in-memory cap); merge by id, dedup by id (and by nonce for own optimistic sends); older gap dropped silently.

### HTTP API contract (Worker)

Bearer auth except register/login; WS route auth via `?token=` (above).

| Method & path | Body → Response | Errors |
|---|---|---|
| POST `/api/register` | `{nickname,password,repeat}` → 201 `{userId,token,profile}` | 400 invalid, 409 nickname_taken |
| POST `/api/login` | `{nickname,password}` → 200 `{userId,token,profile}` | 401 |
| POST `/api/logout` | — → 204 | 401 |
| GET `/api/me` | → 200 `{userId,nickname,color,avatarKey,servers:[{id,name}]}` | 401 |
| PATCH `/api/me` | `{nickname?|color?}` → 200 profile | 400, 401, 409 |
| PUT `/api/me/avatar` | binary + content-type → 200 `{avatarKey}` | 401, 413, 415 |
| GET `/api/avatars/:userId` | → 200 image (R2, `cache-control: public, max-age=300`) | 404 |
| POST `/api/servers` | `{name,password?}` → 201 `{id,name}` (creator = owner+member) | 400, 401 |
| POST `/api/servers/join` | `{serverId,password?}` → 200 `{id,name}`; already-member → 200 idempotent (no password re-check) | 401, 403 wrong_password, 404 |
| GET `/api/servers` | → 200 `[{id,name,role}]` (member-only visibility) | 401 |
| POST `/api/servers/:id/channels` | `{name,kind,password?}` → 201 (owner only) | 400, 401, 403 |
| GET `/api/servers/:id/channels` | → 200 `[{id,name,kind,hasPassword,unlocked}]` ordered by `position ASC, created_at ASC`; password-less channels always `unlocked:true` | 401, 403 |
| POST `/api/channels/:id/unlock` | `{password}` → 204 (writes channel_access; on password-less channel → 204 no-op, no row) | 401, 403, 429 |
| GET `/api/servers/:id/ws` | WS upgrade per protocol section | 401, 403 |
| POST `/api/rtc/*` | per Media-signaling section | 401, 403, 409, 429 |
| GET `/updates/*` | proxies R2 `tavern-updates`, `cache-control: public, max-age=60` | 404 |

Unlock rate limit: per user per channel, key `unlock:{userId}:{channelId}`, FIXED 60 s
window from first attempt (`{count, windowStart}` in DO storage); 6th attempt in window
→ 429.

### D1 schema (migration 0001, exact)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL COLLATE NOCASE UNIQUE,
  nickname_color TEXT NOT NULL DEFAULT '#8a8f98',
  avatar_key TEXT,
  pw_hash BLOB NOT NULL, pw_salt BLOB NOT NULL,
  pw_iterations INTEGER NOT NULL DEFAULT 100000,
  pw_algo TEXT NOT NULL DEFAULT 'pbkdf2-sha256',
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  pw_hash BLOB, pw_salt BLOB,
  created_at INTEGER NOT NULL
);
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','voice')),
  pw_hash BLOB, pw_salt BLOB,
  position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE(server_id, name)
);
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  server_id TEXT NOT NULL REFERENCES servers(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_id)
);
CREATE TABLE channel_access (
  user_id TEXT NOT NULL, channel_id TEXT NOT NULL, granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE budget_usage (
  month TEXT NOT NULL, server_id TEXT NOT NULL,
  est_gb REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (month, server_id)
);
```

### ServerRoom DO SQLite (created in constructor, exact)

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
  content TEXT NOT NULL, nonce TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_nonce ON messages(user_id, nonce);
CREATE TABLE IF NOT EXISTS presence (
  user_id TEXT PRIMARY KEY, conn_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('online','voice')),
  channel_id TEXT, last_seen INTEGER NOT NULL
);
```
Track registry, sfuSessionIds, accrual entries, unlock counters: DO storage
(`ctx.storage`), rebuilt-safe (registry cleared per user on close/sweep). Roster data is
NOT cached: on each hello.ok the DO queries D1 directly (D1 binding on the DO env):
`SELECT u.id,u.nickname,u.nickname_color,u.avatar_key FROM memberships m JOIN users u ON
u.id=m.user_id WHERE m.server_id=?`. Profile changes reach the DO via internal
`POST /internal/profile` (Worker→DO fetch) and are re-broadcast.

**Single 60 s alarm** multiplexes ALL periodic jobs: (1) stale-presence sweep (>75 s), (2)
budget flush to D1 + level re-evaluation (+ `budget` broadcast on change), (3) month
rollover (current UTC `YYYY-MM` differs → new accrual epoch, broadcast `budget` ok), (4)
delete `messages` nonce-window rows is NOT needed (nonce dedup uses created_at window).

### Engine ⇄ UI surface (Tauri commands + events, exact)

Commands (`invoke`):
- `engine_configure({apiBase, token})` — called after login/boot and on token change, before any voice command.
- `engine_status() → {voice:"idle"|"connecting"|"connected"|"reconnecting", publishing:[{kind,trackName}], watching:[{ownerId,trackName,layer}], webcodecsOk:bool}`
- `voice_join(channelId) → {trackName}` (mic trackName) · `voice_leave()`
- `set_mic_muted(muted)` · `set_deafened(deafened)` — deafen sets master output gain 0 AND mutes the mic publish track (remembering prior mic state; undeafen restores both).
- `set_user_gain(userId, gain /*0.0–2.0*/)`
- `set_remote_tracks(tracks:[TrackInfo])` — UI forwards every `tracks` broadcast + hello.ok tracks; engine diffs, auto-subscribes mic tracks while in voice, tears down subscriptions for vanished tracks.
- `screen_sources() → [{id,name,kind:"screen"|"window"}]`
- `screen_share_start({sourceId,width,height,fps}) → {trackName}` — `width=0,height=0` means native (engine uses source size, buckets per simulcast table) · `screen_share_stop()`
- `webcam_list() → [{id,name}]` · `webcam_start({deviceId,width,height,fps}) → {trackName}` · `webcam_stop()`
- `stream_watch({ownerId, trackName, layer, frames: Channel<ArrayBuffer>})` — UI creates the Channel and passes it in the invoke · `stream_unwatch({ownerId, trackName})`

Events (`emit`): `engine://state {voice, err?}` · `engine://levels [{userId,rms}] @10Hz` ·
`engine://stats {json} @1Hz` (bytesSent, bytesReceived, framesEncoded, framesDecoded,
pliCount, iceState, per-track, per-stream `droppedChunks`).

Video chunk payload on the Channel (little-endian):
`{u32 len | u8 keyframe | u64 ptsMs | bytes}`. Engine drops frames until the first
keyframe per stream (first delivered chunk is guaranteed keyframe). `droppedChunks: u64`
per stream increments when `Channel::send` errors or the per-stream outbound queue
exceeds 60 frames (frame discarded); exposed in `engine://stats` and P5 reports.

All Tauri event subscriptions in the app go through one module `app/src/lib/events.ts`
exporting `onEngineEvent(name, cb)`; tests use its helper `emitEngineEvent(name, payload)`
to inject events (mockIPC covers commands only).

### Simulcast / bitrate table (complete, fixed)

Screen share — `h` layer at source resolution; `l` layer ALWAYS 360p@15fps @300 kbps;
listed `h` bitrates are for 30 fps; fps multiplier on `h` only: 15fps ×0.75, 30 ×1.0,
60 ×1.5, 120 ×2.0, round to nearest 50 kbps.

| Screen source | Layers | h kbps @30 |
|---|---|---|
| 1440p | h+l | 4000 |
| 1080p | h+l | 2500 |
| 720p | h+l | 1500 |
| 480p | single | 800 (no multiplier <1.0 floor; apply fps rule) |
| 360p | single | 500 (apply fps rule) |
| native | bucket by captured height: ≥1350→1440 row, ≥900→1080, ≥600→720, else single 800 |

Webcam — bitrates fps-independent:

| Webcam | Layers | h kbps | l |
|---|---|---|---|
| 720p | h+l | 900 | 180p@15 @150 kbps |
| 480p | single | 600 | — |
| 360p | single | 400 | — |

Mic: Opus default (~50 kbps nominal, used for budget accrual). `is_screencast=true` on
screen tracks.

### Performance gates

| ID | Measurement | Gate |
|---|---|---|
| P1 | Publisher: 60 s synthetic to SFU | ICE connected ≤5 s; framesEncoded ≥1500; **pliCount ≤6**; exit 0 |
| P2 | Publisher+subscriber run concurrently 60 s; `spikes/sfu/check_p2.sh` reads both JSONs | framesDecoded ≥ 0.85 × publish framesEncoded; zeroFrameWindows == 0 after 10 s warm-up; **pliCount ≤6** |
| P3 | WebCodecs per webview | 1×1080p30 (dump_1080p) ≥28 fps; 9×360p30 parallel (dump_360p, looped ≥900 frames each) ≥25 fps each |
| P4 | Screen capture per OS | achieved fps ≥ 0.8×target for 10 s at 720p30 and 1080p30 (120 fps: record only) |
| P5 | IPC video channels: exactly 9 streams @300 kbps 360p + 1 @2.5 Mbps 1080p, ≥60 s | Σ droppedChunks == 0; each tile decode ≥25 fps |
| P6 | Voice, 2 engine processes, 1 machine, real SFU, 60 s | audio both ways; `rttMs` = median of candidate-pair currentRoundTripTime @1Hz ≤250 ms; `deviceErrors` (count of engine error events with code prefix `audio_`) == 0 |
| P7 | Reconnect (local/manual, macOS): `networksetup -setairportpower en0 off`, sleep 10, `on`, harness logs 1 Hz stats | framesEncoded/bytesSent resume ≤15 s after the `on` timestamp; gap visible in log; JSON + command transcript committed |

---

## Milestone 0 — Repo, toolchain, CI skeleton

### S0.1 Monorepo scaffold
**Implement:** Layout per §1. Root `package.json` (workspaces, `packageManager`), root
Cargo workspace, `rust-toolchain.toml` (record version), `.nvmrc`, `.gitignore`
(node_modules, target, dist, `.dev.vars`, `*.key`, `.wrangler/`), compiling placeholder
crates (`engine`, `capture`, `protocol`, one unit test each), `app` Vite+Svelte 5 TS,
`worker` hono "ok" route + `wrangler.jsonc` (D1/R2/DO bindings, `new_sqlite_classes`,
budget env vars), `docs/progress.md` template, CI yaml per §1 incl. ubuntu apt line
(bundle job may be red until S0.2).
**DoD:**
- `pnpm install && pnpm -r build` exit 0.
- `cargo test --workspace` exit 0 (≥3 tests); `cargo clippy --all-targets -- -D warnings`; `cargo fmt --check`.
- `pnpm dev:worker` + `curl localhost:8787/` → 200 "ok".
- `git ls-files | grep -E '\.dev\.vars|\.key$'` → empty.

### S0.2 Tauri shell boots
**Implement:** Tauri 2 app (`app.tavern.desktop`), window 1200×760 min 940×560,
`beforeDevCommand: pnpm dev:app`, devUrl :1420, frontendDist `../app/dist`. Placeholder
page sets `data-theme` from `prefers-color-scheme` + Tauri theme event.
**DoD:**
- `pnpm tauri build` exit 0; artifact path/size recorded.
- `pnpm tauri dev` launches (screenshot `docs/qa/s0.2.png`).
- CI `bundle` green on all 3 OS runners.

### S0.3 Test harness
**Implement:** Vitest workspace per §1 Test-stack row: worker project
(pool-workers `^0.18`, vitest `^4.1.0`, `singleWorker:true`, `isolatedStorage:false`,
istanbul coverage, `applyD1Migrations` helper) + app project (vitest-browser-svelte,
Playwright chromium headless, istanbul). One real test each: `SELF.fetch('/')` → 200;
runes counter component click (uses `flushSync`).
**DoD:**
- `pnpm test` both projects green.
- Coverage report produced with non-zero worker lines (verifies istanbul-in-workerd; if impossible → §1 coverage FALLBACK, branch recorded). Thresholds configured, enforcement flips on at S2.1.
- Random-fixture rule documented in `worker/test/README.md`.
- CI `web-test` green.

---

## Milestone 1 — SPIKE gate: native libwebrtc ⇄ Cloudflare Realtime  ⛔ GO/NO-GO

Spike code in `spikes/` (throwaway quality allowed; no unit tests required; every binary
writes machine-readable JSON to `docs/spike-results/`).

### S1.1 Provision Realtime app
**Implement:** Create Realtime/Calls app `tavern-sfu` on account `fd8a5f7a…` via the
Cloudflare API. `CF_APP_ID` → wrangler var; `CF_APP_SECRET` → `worker/.dev.vars` (+ noted
for S6.0 `wrangler secret put`). Document the call (secret redacted) in progress.md.
**DoD:** API GET of the app → 200 (logged, redacted); `git grep <secret>` in tracked
files → nothing.

### S1.2 Spike publisher (P1)
**Implement:** `spikes/sfu/src/bin/publish.rs` (`libwebrtc = 0.3.38`): synthetic moving
color bars via `NativeVideoSource::capture_frame` + 440 Hz sine via `NativeAudioSource`;
CLI flags `--width --height --fps` (default 640×360@30); one PC, sendonly transceivers,
offer → SFU HTTPS (env creds); STUN per §1. 60 s run, 1 Hz getStats, writes
`publish.json {iceConnectedMs, framesEncoded, bytesSent, pliCount, requestShapes}`
(requestShapes = the exact SFU request/response JSON bodies used, secrets redacted).
Crib from livekit/rust-sdks source + openai/codex `codex-rs/realtime-webrtc`; field names
from official docs.
**DoD:** P1 gates; JSON committed.
**FALLBACK:** SFU rejects SDP/ICE beyond what docs + calls-examples resolve → STOP
(LiveKit-server pivot is the user's decision).

### S1.3 Spike subscriber (P2) + simulcast layer pull + TURN check
**Implement:** `subscribe.rs`: pulls the published track — client is SDP **answerer**;
handle immediate-renegotiation. Concurrent run protocol: start publish.rs, start
subscribe.rs within 5 s, both run 60 s, each writes its JSON;
`spikes/sfu/check_p2.sh` evaluates P2 across the two files.
Simulcast: run publish with 2 encodings (rid h/l); pull the track TWICE (once low rid,
once high rid; field name per official docs, recorded); assert h-pull bitrate ≥3× l-pull
over 30 s. Record `turnRequired` (whether STUN-only connected).
`subscribe.json {iceConnectedMs, framesDecoded, zeroFrameWindows, pliCount,
layersNegotiated, layerPull:{low_kbps, high_kbps, requestShapes}, turnRequired}`.
**DoD:** P2 via check_p2.sh exit 0; `layersNegotiated == 2`; `high_kbps ≥ 3×low_kbps`;
layer-pull request shapes recorded. If pliCount gate fails in a ~3 s periodic pattern →
STOP (known SFU native-client PLI hazard; user decides). If `turnRequired == true` →
STOP (TURN provisioning needs approval).

### S1.4 Encoded-frame tap
**Implement (primary):** extract **encoded** frames from the libwebrtc receive path
(frame-transformer / frame-cryptor-style hook). Run twice: against the 640×360@30 publish
AND against `publish --width 1920 --height 1080 --fps 30`. Write `dump_360p` and
`dump_1080p` (IVF for VP8/VP9, Annex-B for H264), ≥300 frames each. Requires ffmpeg
(`brew install ffmpeg`, version recorded; local-only).
**FALLBACK (pre-authorized, in order):** (a) `str0m` (latest, pin) subscriber leg used
only for video pulls (answers the SFU offer, emits depacketized encoded samples); (b)
both fail → STOP.
**DoD:** `ffprobe -count_frames -show_entries stream=codec_name,nb_read_frames <dump>` —
codec matches negotiated, `nb_read_frames ≥ 290`, both dumps; branch recorded.

### S1.5 WebCodecs decode probe (P3) → codec decision
**Implement:** Tauri page `spikes/webcodecs/`: Tauri Channel binary IPC feeds the dumps →
`VideoDecoder` (codec strings per §1) → canvas. Measures `isConfigSupported`
(vp8/vp9/h264), 1×1080p30 (dump_1080p) fps, 9 parallel 360p30 decoders (dump_360p looped
≥900 frames each). macOS local now; Windows/Linux via CI-built bundle when hardware
available.
**DoD:** P3 gates on macOS (hard); per-OS/codec table in `docs/spike-results.md`;
**codec decision recorded** per §1 rule (macOS + known WebView2/Chromium support; revisit
flag for Win/Linux noted).

### S1.6 Capture + audio spike (P4)
**Implement:** `spikes/capture/`: macOS screen grab 10 s at 720p30 + 1080p30 → JSON
achieved-fps + PNG; TCC prompt behavior noted. Audio: (a) ADM check — play a 440 Hz tone
via ADM playout while capturing 2 s from default mic → WAV +
`audio.json {admInitOk, playoutErrors, captureRmsDbfs}`; gates: `admInitOk`,
`playoutErrors==0`, `captureRmsDbfs > -50` (speakers on; local/manual env noted). Fail →
cpal FALLBACK, same JSON gates. (b) Playout-path check (required in BOTH branches): pull
one remote audio track, obtain its per-track AudioStream PCM, route through a gain stage
to a cpal output callback; `playout.json {framesDelivered ≥ 100, cpalCallbacks ≥ 100}`.
Windows/Linux capture spikes compile in CI; runtime deferred.
**DoD:** P4 on macOS; audio branch + playout proof recorded; all JSONs committed.

### S1.7 GO/NO-GO
**DoD:** `docs/spike-results.md` complete: P1–P4 evidence, codec decision, audio branch,
video-tap branch, layer-pull shapes, turnRequired=false. Any FALLBACK dead-end → halt.
Otherwise **GO**.

---

## Milestone 2 — Control plane (offline, TDD; coverage enforced from S2.1)

### S2.1 D1 migrations + crypto helper
**Implement:** Migration 0001 (§1 SQL). `worker/src/lib/crypto.ts`: `hashPassword`,
`verifyPassword`, `mintToken`, `hashToken`. Flip coverage enforcement on.
**DoD:** Tests: migration applies; UNIQUE nickname constraint error; hash round-trip
true/false; pinned self-generated PBKDF2 vector (derive once, assert hex); token hash is
64-hex. Coverage ≥85% worker (or FALLBACK branch gates).

### S2.2 Auth endpoints
**Implement:** register/login/logout/me per §1 contract + zod schemas + bearer middleware
(hash lookup, `last_seen_at` update).
**DoD:** ≥10 SELF.fetch cases: happy register→login→me; 400s (regex, short password,
mismatch); 409 duplicate case-insensitive (`Bob` vs `bob`); 401 wrong password; logout
revokes. Coverage holds.

### S2.3 Servers, channels, membership, unlock
**Implement:** Endpoints per §1 contract incl. idempotent re-join, owner-only channel
create, unlock with fixed-window rate limit (key/window per §1), channel list ordering +
`unlocked` semantics.
**DoD:** ≥12 cases incl.: non-member channels list 403; server list = memberships only;
wrong server password 403; nonexistent-server join still calls `verifyPassword` exactly
once (spy call-count) and returns a response deep-equal in shape/status to the
wrong-password case; unlock happy/wrong/429 (6th in window, injectable clock);
password-less unlock 204 no-op; already-member re-join 200 no-change.

### S2.4 ServerRoom DO: WS, presence, chat
**Implement:** Upgrade flow per §1 (Worker validates `?token=` + membership pre-upgrade,
`X-Tavern-User` header, immediate `hello.ok` with D1 roster query per §1). Hibernatable
WS; single-session supersede (4002); protocol v1: chat.send (persist + broadcast, nonce
dedup via messages.nonce per §1), chat.history (paging per §1), voice.join/leave rules
(`invalid` on non-voice channel, same-server rejoin), `locked` enforcement for pw
channels, presence transitions (offline = row DELETE + broadcast), heartbeat/heartbeat.ok,
single 60 s alarm (all jobs per §1), injectable `nowMs()`, `serializeAttachment`.
**DoD:** ≥16 pool-workers cases: two WS clients chat roundtrip; duplicate nonce delivered
once — INCLUDING across a hibernation eviction (`evictDurableObject` between sends);
history pagination (55 msgs → 50+hasMore, beforeId); presence matrix (accept→online,
voice.join→voice broadcast, close→offline DELETE, superseded old socket gets 4002 and NO
offline broadcast); voice.join text-channel → `invalid`; locked channel chat.send +
voice.join → `locked`, then after unlock endpoint both succeed; stale sweep via
`runDurableObjectAlarm` + injectable clock reaps >75 s; message-before-nothing (no hello
needed — any valid message works immediately after hello.ok). Coverage ≥85%.

### S2.5 Profiles + avatars (R2)
**Implement:** PATCH /me (409 collision), PUT /me/avatar (limits per §1 → R2
`avatars/{userId}`), GET avatar proxy, profile broadcast via `POST /internal/profile`
Worker→DO fetch to all servers of the user.
**DoD:** ≥8 cases: 413 at 512 KB+1; 415 `image/gif`; R2 roundtrip bytes equal; PATCH
collision 409; connected WS receives `profile` after PATCH (through the internal route).

### S2.6 RTC proxy, track registry, share cap, budget
**Implement:** `/api/rtc/*` per §1 Media-signaling section (bodies, DO authorization,
sessionId recording, registry + `tracks` broadcasts, share cap 409, subscribe-side budget
checks: hard → 403 all video; soft behavior deferred to S6.2 — forward note), accrual
engine (per-layer bitrates from §1 tables incl. mic 50 kbps; entries finalized on
unsubscribe/close/webSocketClose/stale-sweep), 60 s alarm flush → D1 `budget_usage` +
level eval from account-wide SUM, `budget` broadcasts, rtc rate limit 10/s/user.
SFU HTTPS mocked by stubbing `globalThis.fetch` in test setup (match URL prefix
`https://rtc.live.cloudflare.com/`, replay S1.2/S1.3 recorded shapes; other URLs pass
through). Do NOT use `fetchMock` (removed from pool-workers).
**DoD:** ≥14 cases: not-in-voice 403; publish → registry + `tracks` broadcast (with
width/height/fps); 4th concurrent screen publish 409 share_limit; subscribe resolves
sessionId server-side (client body has no sessionId — assert mock captured request);
single-layer track ignores `layer`; accrual grows under injectable clock, stops on
unsubscribe AND on subscriber WS close; mic accrues at 50 kbps and is never blocked at
hard; hard level rejects video subscribe 403 budget_exceeded; two seeded `budget_usage`
rows sum to trip the level; flush writes D1 row; secret never in any response (assert
across all rtc responses); 429 on 11th call/sec. Coverage ≥85%.

---

## Milestone 3 — Frontend shell (against local worker)

### S3.1 App skeleton, theming, onboarding
**Implement:** Runes state modules (`auth.svelte.ts`, `servers.svelte.ts`,
`chat.svelte.ts`, `voice.svelte.ts`), `events.ts` (per §1), screens: Onboarding
(register/login, §1 validation mirrored), Main layout (server rail · channel list · chat
pane · member list with presence dots · voice panel placeholder). Theme tokens light+dark;
`prefers-color-scheme` + Tauri theme event; override cycle system→light→dark persisted
(store plugin). Chat pane in-memory cap 200 messages.
**DoD:** Component tests: form valid/invalid states; theme flips `data-theme` and
persists; member list renders roster fixture with presence classes; 200-cap asserted.
App coverage ≥70%.

### S3.2 WS client + resume
**Implement:** `ws.svelte.ts` per §1 protocol semantics: state machine
connecting→open→backoff (exact 1,2,4,8,16,30… no jitter), heartbeat 20 s + 45 s watchdog
force-close, resume gap-fill algorithm (§1, 4-page cap), nonce dedup for own sends, one
WS per joined server (≤5).
**DoD:** App-project tests with scripted mock WS server: drop→resume no-loss/no-dupe
(sequence assertions); backoff exact values (fake timers OK here — browser project);
watchdog closes at 45 s silence. Worker-project integration test: a ~30-line plain
protocol driver class (`new WebSocket` in workerd) against SELF exercising
connect→chat.send→drop→reconnect→gap-fill at the protocol level. `ws.svelte.ts` itself is
tested only in the app project.

### S3.3 Tauri boot + keyring
**Implement:** keyring plugin (§1 pin) stores `{userId, token}`; boot: keyring → `/me` →
Main (+`engine_configure`), else Onboarding; invalid token clears keyring. Rust command
wrappers behind a trait (mockable).
**DoD:** cargo tests (mock store); mockIPC tests: valid-token → Main + engine_configure
invoked with `{apiBase, token}`; invalid-token → keyring cleared → Onboarding. Manual:
restart stays logged in (`docs/qa/s3.3.md`).

### S3.4 Control-plane dialogs
**Implement:** Server rail `+` → Create Server dialog {name, optional password} and Join
Server dialog {serverId, optional password}; owner-only `+` in channel list → Create
Channel dialog {name, kind, optional password}; clicking a `hasPassword && !unlocked`
channel → password prompt → unlock endpoint (429/403 shown as inline errors); Settings
modal (gear on self): nickname, color (§1 validation), avatar file input (client-side
≤512 KB + type check) → PATCH/PUT; Logout → POST logout + keyring clear → Onboarding.
**DoD:** ≥10 component tests: each dialog's validation + happy dispatch (fetch spied),
unlock error rendering, logout flow (spies: POST + keyring clear + route change).

---

## Milestone 4 — Voice end-to-end

### S4.1 Engine: voice core
**Implement:** `crates/engine`: session lifecycle vs `/api/rtc/*` (reqwest, token/base
from `engine_configure`; offerer publish path, answerer pull path, renegotiate); capture
per S1.6 branch → APM `process_stream` → publish mic (trackName per §1);
`set_remote_tracks` diffing with mic auto-subscribe (subscribe → per-track AudioStream);
**playout pipeline (fixed):** per-track PCM → per-user gain → mix → every 10 ms mixed
frame passes `apm.process_reverse_stream()` immediately before the cpal output ring
buffer; capture frames pass `process_stream()` after the corresponding reverse call
(10 ms framing, resample as needed). RMS per user @10 Hz; stats @1 Hz; deafen per §1
(output gain 0 + mic mute + state restore); double-join rejected.
**DoD:** cargo tests: mixer math (gain, clamp, saturation); state machine
(join→connected→leave idempotent, double-join error); APM smoke (1 s sine ≠ passthrough);
**reverse-stream wiring: instrumented APM wrapper asserts ≥90 `process_reverse_stream`
calls during 1 s synthetic playout and capture-processing ordered after reverse**;
deafen: mic frames stop reaching the sender, undeafen restores prior mic state; signaling
client vs mock HTTP server covering publish path, pull path (server-offers/client-answers)
and renegotiate. Engine coverage ≥70%.

### S4.2 Voice UI + controls
**Implement:** Voice panel: join/leave; **fixed sequencing:** UI sends WS `voice.join`,
waits for own `presence {state:"voice"}` broadcast (5 s timeout → error toast), THEN
invokes engine `voice_join`; leave = engine `voice_leave` first, then WS `voice.leave`.
Cross-server: invoking join while in voice anywhere performs full leave (old server)
first. Mute, deafen, per-user sliders (0–200%, persisted per userId via store plugin),
speaking rings (RMS > 0.02 for ≥100 ms) via `emitEngineEvent` helper.
**DoD:** Component tests: sequencing order asserted (mockIPC + scripted WS: engine
voice_join NOT invoked before presence arrives; leave order reversed); slider persistence
+ re-apply; deafen button state; speaking ring on synthetic levels.

### S4.3 Voice E2E (P6)
**Implement:** `spikes/e2e-voice/`: two engine processes, one machine, seeded local
worker + real SFU, 60 s bidirectional.
**DoD:** P6 gates (rttMs median, deviceErrors == 0 per §1 definitions); JSON committed.
Manual cross-machine QA `docs/qa/voice.md` (echo on speakers, deafen, per-user volume) —
macOS now, Win/Linux deferred per §1 Platform-reality row.

---

## Milestone 5 — Screen share & webcam end-to-end

### S5.1 Capture crate
**Implement:** `crates/capture` trait: `list_screen_sources()`, `open_screen(source,cfg)`,
`open_webcam(device,cfg)` → frame stream → I420 (libwebrtc `yuv_helper`); per-OS impls
per §1; resolution mapping incl. native bucketing (§1 table); requested-vs-achieved fps
reported; Linux runtime portal/PipeWire check → typed error.
**DoD:** Unit tests: config mapper table-driven over ALL §1 rows × 4 fps values
(24 combos: expected layers + h-bitrate after fps multiplier); I420 golden checksum;
fake-capturer lifecycle. macOS: P4 re-run through the real impl. Win/Linux compile in CI.

### S5.2 Publish screen/webcam
**Implement:** Engine: `screen_share_start` → capture → `NativeVideoSource`
(`is_screencast=true`) → publish via `/api/rtc/publish` with layers/bitrates from §1
table; `webcam_start` via nokhwa likewise; stop = `/api/rtc/unpublish` + teardown.
**DoD:** cargo tests: encoding-params builder exactly matches the §1 table (table-driven,
all rows × fps); publish/unpublish state machine; share-cap 409 surfaces as typed engine
event. Local: real 720p30 screen 60 s to SFU, framesEncoded ≥ 0.8×expected, JSON committed.

### S5.3 Share UI
**Implement:** Share button in voice panel → picker dialog (screens + windows from
`screen_sources()`), resolution select (native/360/480/720/1080/1440), fps select
(15/30/60/120), Start/Stop, "You are sharing" indicator; Start disabled when the `tracks`
roster already shows 3 screen tracks in the channel.
**DoD:** ≥8 component tests: picker→`screen_share_start` payload mapping for ≥6
res/fps combos (incl. native→0×0), stop mapping, 3-share disable state from roster
fixture.

### S5.4 Watch streams (P5)
**Implement:** Stream tiles from `tracks` roster (screen+webcam kinds): Join Stream /
Leave per tile; joined = `stream_watch` with UI-created Channel → WebCodecs (codec string
per spike record) → canvas grid; exactly one pinnable tile → layer `h` (enforced in
`voice.svelte.ts`; pin change = unwatch+watch per §1; pinned track vanishing resets pin
to none); non-simulcast tiles: pin control disabled; leave = `stream_unwatch`.
**DoD:** Component tests: join/leave states; pin swap issues unwatch+watch with layers
asserted; pin disabled for `simulcast:false`; canvases mount/unmount. Local measurement:
**P5 exactly as defined** (9 spike publishers @300 kbps 360p + 1 @2.5 Mbps 1080p, 60 s):
Σ droppedChunks == 0, per-tile ≥25 fps, JSON committed. Egress-stop proof: snapshot
track's inbound-rtp bytesReceived before unwatch; poll 10 s after — PASS if stat entry
absent OR delta <5 KB.

### S5.5 Webcam UI
**Implement:** Webcam on/off + res/fps picker (§0 subsets) in voice panel; tile appears
in the same grid (watchers join manually).
**DoD:** Component tests picker→command mapping (all 6 combos); manual QA with real
webcam (macOS) recorded.

---

## Milestone 6 — Production, resilience, packaging

### S6.0 Provision + deploy production
**Implement:** On account `fd8a5f7a…`: `wrangler d1 create tavern-db` +
`wrangler d1 migrations apply tavern-db --remote`; `wrangler r2 bucket create
tavern-avatars` + `tavern-updates`; `wrangler secret put CF_APP_SECRET`;
`wrangler deploy` Worker `tavern`. Record the exact workers.dev URL; set prod
`VITE_API_BASE` build config.
**DoD:** `curl https://<url>/` → 200; register+login+me roundtrip against prod (curl
transcript, tokens redacted); resources + URL recorded in progress.md.

### S6.1 Reconnection (P7)
**Implement:** Engine: on ICE disconnect → `restart_ice` + renegotiate via proxy, bounded
5 retries then error event; UI: on WS resume → re-join voice + re-publish + re-watch
previous set (state in `voice.svelte.ts`); `reconnecting` banner.
**DoD:** cargo tests: reconnect state machine (disconnect→restarting→connected; 5-retry
exhaustion → error). Worker test: `evictDurableObject` mid-session → protocol driver
reconnects, roster restores. Local/manual P7 per §1 (command transcript + JSON committed).

### S6.2 Budget finalization + UI
**Implement:** Add soft-level rule to rtc/subscribe: while `soft`, `layer:"h"` → 403
budget_exceeded (client may retry `l`); UI: `budget` events → soft banner + auto-drop all
tiles to `l` + pin disabled; hard → watch buttons disabled with tooltip; engine stats
egress estimate logged vs DO estimate (log only).
**DoD:** Worker tests: soft rejects `h` but allows `l`; hard rejects all video, mic
unaffected; rollover (clock injection) resets and broadcasts. UI tests: banner, tile
downgrade dispatched, disabled states.

### S6.3 Packaging + updater + runtime requirement checks
**Implement:** Bundle config: macOS Info.plist (NSCameraUsageDescription,
NSMicrophoneUsageDescription) + entitlements (camera, audio-input) +
`minimumSystemVersion "13.3"` (WebCodecs floor); Windows NSIS; Linux AppImage+deb.
Boot probe on ALL OSes: `typeof VideoDecoder !== 'undefined'` (reported in
`engine_status().webcodecsOk`) → blocking error screen if absent (Linux message:
"Tavern requires WebKitGTK ≥ 2.46"); Linux additionally checks portal/PipeWire (typed
error dialog from S5.1). Updater: `tauri-plugin-updater`, manifest
`https://tavern.<subdomain>.workers.dev/updates/latest.json` (Worker route → R2
`tavern-updates`, cache 60 s); signing keys generated, private key NOT committed; a
manifest-generation script (version/platform → JSON validated by a pinned zod schema).
`docs/release.md` documents signing/notarization steps.
**DoD:** CI bundles on 3 OSes; worker test: GET /updates/latest.json serves R2 object
with correct content-type; unit test: manifest script output validates against schema;
UI test: missing VideoDecoder (mocked) → error screen state; macOS bundle passes
`codesign -d --entitlements :-` listing both entitlements; local update roundtrip
(install → bump patch → manifest to local R2 → update applies; manual, recorded).

### S6.4 Final QA matrix
**Implement:** `docs/qa/final.md`: feature × OS pass/fail table covering every §0
IN-scope feature.
**DoD:** macOS column fully PASS; Win/Linux filled or explicitly deferred with user
sign-off; all P1–P7 evidence in repo; `pnpm test` + `cargo test` + clippy + coverage
green at HEAD.

---

## Progress protocol (mandatory)

After each step append to `docs/progress.md`:
`## S<id> — <date> — DONE | tests: <n> passed | measurements: {…} | commit <sha> | deviations: none|<listed>`.
Deviations that aren't a labeled FALLBACK = step NOT done → blocker protocol. Never start
step N+1 with step N incomplete. On session resume: read progress.md, verify HEAD green
(`pnpm test` + `cargo test --workspace`) before continuing.
