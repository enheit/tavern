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

## P1 / P2 / video-tap / TURN (S1.2–S1.4)

Recorded in [`progress.md`](progress.md); summarized here at S1.7. Highlights so far:
- **P1** (publisher) PASS; **P2** (subscriber + simulcast layer pull, 4.0× h/l ratio) PASS; `turnRequired=false`.
- **Video-tap branch (S1.4):** FALLBACK (a) — str0m subscriber leg (the libwebrtc 0.3.38 binding
  exposes no encoded-frame receive hook). Dumps: VP8 IVF, 300 frames each at 360p and 1080p.
