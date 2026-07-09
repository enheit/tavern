# S6.4 — Final QA matrix (feature × OS)

2026-07-09. Every §0 IN-scope feature, per OS. Win/Linux runtime is DEFERRED per PLAN
§1 platform-reality (code compiles + unit tests + bundles green in the 3-OS CI matrix;
runtime gates need real hardware — never faked). Gates: `pnpm test` (app 96 + worker
92), `cargo test --workspace` (60), clippy `-D warnings`, coverage (worker ≥85 /
app ≥70 / rust ≥70 llvm-cov) — CI run 28988858297 (all 7 jobs ✓) + local runs.

**S6.4 finding (fixed):** the worker sent no CORS headers, so the *bundled* app
(webview origin `tauri://localhost`) could not call `/api/*` at all — login died with
`network_error`; the preflight OPTIONS even hit bearerAuth and 401'd. Never caught
earlier because no prior gate exercised a real webview against a real worker. Fixed
with `hono/cors` on `/api/*` (origin-allowlisted: tauri://localhost,
http(s)://tauri.localhost, localhost:1420), mounted before the routes; +2 worker
tests; deployed (version d9b7fabc) and verified live from the bundle.

| §0 feature | macOS | Windows | Linux | Evidence |
|---|---|---|---|---|
| Registration / login / logout (nickname+password+repeat) | PASS | DEFERRED | DEFERRED | worker auth suite (PBKDF2-100k, timingSafeEqual, sessions); app onboarding tests; prod roundtrip `qa/s6.0-prod-roundtrip.txt` (201/200/200) |
| Servers: owner create, join by ID+password, switcher | PASS | DEFERRED | DEFERRED | worker server routes suite (incl. wrong-password 403); app switcher tests; `docs/screenshot.png` (live app) |
| Channels: text + voice, optional password asked once & remembered | PASS | DEFERRED | DEFERRED | worker channel tests; app channel-password modal + remembered-pref tests |
| Text chat: messages, 50/page history pagination, member list | PASS | DEFERRED | DEFERRED | DO chat tests (pagination boundary); ChatPane tests (author nickname in §0 color — S6.3 fix); member-list tests |
| Presence: offline / online / voice | PASS | DEFERRED | DEFERRED | worker presence tests incl. DO-evict restore (S6.1); presence dots in live screenshot; P6/P7 runs show `voice` |
| Voice: join/leave, mute, deafen, per-user volume 0–200%, speaking indicators | PASS¹ | DEFERRED | DEFERRED | **P6 PASS** `spike-results/p6-a/b.json` (real 2-engine run, real SFU: rtt 8/7 ms ≤250, audio both ways, deviceErrors 0); engine VoiceSm/mixer tests; app voice UI tests; reconnection **P7 PASS** `spike-results/p7.json` (ICE recovered 1 959 ms ≤15 s) |
| Screen share: picker, native/360–1440 × 15–120 fps, ≤3/channel | PASS | DEFERRED | DEFERRED | S5.2 60 s live share `spike-results/s5.2-share.json`; **P4** `spike-results/s5.1-p4.json` (720p30 26.98 / 1080p30 28.28 fps ≥0.8×target); 24-combo §1 table test; worker `share_limit` 409 test |
| Webcam: on/off, 360/480/720 @ 15/30 | PASS¹ | DEFERRED | DEFERRED | 6-combo §1 mapping tests (engine video.rs); capture fake-webcam lifecycle tests; app picker/indicator tests |
| Watching: manual join/leave, multi-watch, one pinned h + rest l | PASS | DEFERRED | DEFERRED | **P5 PASS** `spike-results/p5.json` (9×360p@300k + 1×1080p@2.5M, 60 s, ΣdroppedChunks 0, every tile ≥25 fps); layer h/l `spike-results/sub-h/l.json`; S5.4 tile/watch-session tests |
| Profile: nickname, color, avatar ≤512 KB | PASS | DEFERRED | DEFERRED | worker profile tests (limits, mime, 512 KB reject); app profile UI tests |
| Cost guards: egress budget soft/hard caps | PASS | DEFERRED | DEFERRED | S2.6+S6.2 worker matrix (soft: h→403/l→ok; hard: all video 403; mic never; UTC-month rollover broadcast); app banner/disable tests |
| Auto-updater (R2 manifest via Worker route) | PASS | DEFERRED | DEFERRED | **local roundtrip PASS** `qa/s6.3-update-roundtrip.txt` (0.1.0→0.1.1 applied + verified); worker route + zod manifest schema tests; GitHub release v0.1.0 |

¹ Automated gates PASS; the human-perceptual complements were run 2026-07-09 (sheets
below) — sole exception: echo/AEC by ear, which needs a second machine.

## Human-perceptual sheets (macOS) — run 2026-07-09

Session: two release-bundle instances on one machine (`qa_final_a`/`qa_final_b`),
prod worker + real SFU.

| Sheet | Covers | Status |
|---|---|---|
| `qa/s3.3.md` | real keychain survives full app restart | PASS |
| `qa/voice.md` | deafen restore, per-user volume, speaking rings | PASS — echo/AEC-by-ear DEFERRED (second machine; user signed off; P6 automated backstop) |
| `qa/webcam.md` | camera TCC prompt, live picture quality/aspect by eye | PASS (all 5 checks) |

## Windows / Linux deferral (PLAN §1)

CI proves per-OS compile, unit tests, and bundle creation (NSIS / AppImage+deb) on
every push; no Windows or Linux hardware was available for runtime QA. Deferred rows
flip only after a run on real hardware.

User sign-off: ✓ Roman, 2026-07-09 (in-session; also covers the echo/AEC-by-ear
deferral above).
