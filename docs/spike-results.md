# Tavern — SPIKE results (Milestone 1)

Consolidated evidence for the M1 GO/NO-GO gate (S1.7). Per-step measurements and the full
narrative live in [`progress.md`](progress.md); this file records the **decisions** and the
cross-OS tables the plan's DoDs call out. Completed incrementally S1.4→S1.7.

---

## Video codec decision (S1.5)

**Decision: VP8** — codec strings `"vp8"` (decode) / publish VP8 (PT 100). Per PLAN §1: prefer
VP8 unless any target webview's WebCodecs fails VP8, in which case fall back to H264
(`"avc1.42E01F"`). VP8 decode is supported and passes P3 on the hard-gate platform (macOS
WKWebView), so VP8 stands.

**Revisit flag (Windows/Linux):** the decision is locked on macOS + *known* WebView2 (Chromium)
and WebKitGTK VP8 support; the actual P3 fps table for Windows/Linux is filled when a CI-built
bundle runs on that hardware (S1.5 defers Win/Linux runtime). If either webview fails VP8
`isConfigSupported` or the P3 fps gate there, the codec flips to H264 for all platforms and the
S1.4 dumps must be regenerated from an H264 publish.

### WebCodecs `isConfigSupported` (per-OS × codec)

| OS / webview | vp8 (`vp8`) | vp9 (`vp09.00.10.08`) | h264 (`avc1.42E01F`) |
|---|---|---|---|
| macOS 26 / WKWebView (Safari 26) | ✅ | ✅ | ✅ |
| Windows / WebView2 (Chromium) | pending CI bundle | pending | pending |
| Linux / WebKitGTK | pending CI bundle | pending | pending |

### P3 decode gate (VP8)

Gate: 1×1080p30 ≥28 fps; 9×360p30 parallel (each looped ≥900 frames) ≥25 fps each. Inputs are
the S1.4 dumps (`dump_1080p.ivf`, `dump_360p.ivf`), streamed over a Tauri binary `Channel` to a
`VideoDecoder` → canvas.

| OS | 1×1080p30 fps | 9×360p30 min fps | P3 |
|---|---|---|---|
| macOS 26 / WKWebView | **31.05** (≥28 ✅) | **72.49** (≥25 ✅) | **PASS** |
| Windows / WebView2 | pending CI bundle | pending | pending |
| Linux / WebKitGTK | pending CI bundle | pending | pending |

**macOS caveat (software VP8):** Apple has no hardware VP8 decoder, so WebKit decodes VP8 in
software. 1080p VP8 is therefore CPU-bound and clears the ≥28 gate with a thin margin (31 fps);
360p is cheap (9 parallel decoders each sustain ~72 fps). The *combined* 9×360p + 1×1080p load is
not P3 — it is measured by **P5** (S2.x IPC channels), where this software-decode headroom is the
thing to watch.

Raw numbers: [`spike-results/webcodecs.json`](spike-results/webcodecs.json).

---

## Capture + audio (S1.6)

### Screen capture (P4, macOS)

libwebrtc `DesktopCapturer` (ScreenCaptureKit backend), primary display 2880×1800, driven at
30 fps for 10 s; achieved fps measured in a lightweight count-only callback (the per-pixel
downscale to the target runs once, for the PNG). Gate: achieved fps ≥ 0.8×30 (=24).

| OS | 720p30 | 1080p30 | P4 |
|---|---|---|---|
| macOS 26 (release build) | **28.43 fps** | **28.61 fps** | **PASS** |
| Windows / Linux | compiles in CI; runtime deferred | — | pending |

Screen Recording TCC already granted (real frames captured, `tccBlocked=false`). A **release
build is required** — a debug build with the naive downscale in the capture callback throttled
SCK delivery to ~11–19 fps. `screen-{720,1080}p.json` committed; PNGs gitignored (desktop content).

### Audio capture decision (S1.6a)

**Decision: cpal capture.** Playout is always engine-owned cpal (§1). The libwebrtc ADM
*initializes* (`acquire_platform_adm`/`init_recording`/`start_recording` → true) but
`create_device_audio_track` + `NativeAudioStream` delivered **0 frames standalone** (no
PeerConnection to drive the audio graph), so ADM capture-to-PCM is not viable outside a peer
connection. cpal mic capture works: RMS **−37.9 dBFS** (> −50), `playoutErrors=0`. APM
(AEC/NS/AGC) is applied to cpal-captured audio in the app (mandatory in both branches, per §1).
`audio.json` committed.

### Engine-owned playout path (S1.6b)

Pull the publisher's remote audio track → per-track `NativeAudioStream` decoded PCM → gain →
`cpal` output callback. `framesDelivered=885`, `cpalCallbacks=562` (gate ≥100 each) → **PASS**.
`playout.json` committed.

---

## SFU round-trip: P1 / P2 / layer-pull / TURN (S1.2–S1.4)

Native libwebrtc (0.3.38, `-ObjC`) ⇄ Cloudflare Realtime SFU (`tavern-sfu`), STUN-only
(`stun.cloudflare.com:3478`), candidate-less offer/answer → ICE-lite SFU connects peer-reflexively.

### P1 — publisher (S1.2)

| Metric | Value | Gate | |
|---|---|---|---|
| iceConnectedMs | 477 | ≤5000 | ✅ |
| framesEncoded (60 s) | 1819 | ≥1500 | ✅ |
| pliCount | 0 | ≤6 | ✅ |
| exit | 0 | 0 | ✅ |

The documented ~3 s native-libwebrtc PLI/keyframe stutter did **not** manifest on the publish
path (pliCount stayed 0). `publish.json` (redacted request shapes for S2.6 mocks).

### P2 — subscriber + simulcast layer pull (S1.3)

| Metric | Value | Gate | |
|---|---|---|---|
| framesDecoded (60 s) | 1788 | ≥ 0.85 × 1811 (=1539) | ✅ |
| zeroFrameWindows (post-warmup) | 0 | 0 | ✅ |
| pliCount | 1 | ≤6 | ✅ |
| iceConnectedMs | 448–550 | ≤5000 | ✅ |
| layersNegotiated | 2 | 2 (h/l) | ✅ |
| layer ratio (high/low kbps) | 1012 / 251 = **4.0×** | ≥3× | ✅ |

**Release build required** for clean concurrent decode (debug starved the receive path — CPU
contention, not an SFU hazard). Evidence: `subscribe.json`, `sub-l.json`, `sub-h.json`.

**Layer-pull request shape** (recorded, for S2.x subscribe proxy):
```json
"simulcast": { "preferredRid": "h" | "l", "priorityOrdering": "asciibetical", "ridNotAvailable": "asciibetical" }
```
Two independent per-rid pulls (`--rid l`, `--rid h`). Per-stream `maxBitrate` must stay under the
puller's BWE for `preferredRid` selection to work (cap h=1.0 Mbps < ~1.7 Mbps downlink) — this is
the cost lever: grid tiles pull `l` (~250 kbps), pinned pulls `h` (~1 Mbps).

### TURN

`turnRequired = false` across all three subscriptions (P2 basic + both simulcast pulls). STUN-only
is the expected outcome (SFU is publicly addressable); TURN was **not** provisioned and is not
needed. No STOP condition hit.

### Video-tap branch (S1.4)

**FALLBACK (a): str0m subscriber leg.** The primary path (extract encoded frames via the libwebrtc
receive-side frame-transformer/cryptor hook) is not viable — the 0.3.38 binding runs both
`FrameTransformerInterface` impls in C++ and returns only metadata to Rust. str0m (0.21, rust-crypto)
answers the SFU offer and emits depacketized encoded VP8 → IVF: `dump_360p.ivf`, `dump_1080p.ivf`,
300 frames each (ffprobe: `codec_name=vp8`, `nb_read_frames=300`). This is a **working** fallback,
not the (b) STOP.

---

## FALLBACK audit (S1.7 halt-check)

The plan halts M1 only if a FALLBACK reaches a dead-end. None did:

| Point | Primary | Outcome |
|---|---|---|
| S1.4 encoded-frame tap | libwebrtc frame-transformer hook (not exposed) | ✅ FALLBACK (a) str0m — works; (b) STOP not reached |
| S1.6 audio capture | libwebrtc ADM (no standalone PCM) | ✅ cpal capture — the §1-sanctioned branch |
| S1.3 TURN | STUN-only | ✅ STUN-only achieved; TURN not needed |

Every hard gate (P1–P4) passed on the mandated macOS platform. Windows/Linux runtime (P3/P4) is
deferred to CI-built bundles per the step texts, with the codec revisit flag noted above.

---

## Verdict — **GO** ✅

Native libwebrtc ⇄ Cloudflare Realtime is validated end-to-end on macOS: publish (P1), subscribe +
simulcast layer selection (P2), encoded-frame extraction for the decode probe (S1.4), WebCodecs
decode at grid scale (P3 → **VP8**), screen capture (P4), audio capture (**cpal**) + engine-owned
playout. No FALLBACK dead-end, no STOP condition, `turnRequired=false`. **Milestone 1 GO** —
proceed to Milestone 2.
