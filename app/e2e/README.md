# Real-browser e2e (web build)

Two-user roundtrips against a local worker + the **real** Cloudflare Realtime SFU —
nothing mocked. `web-chat.mjs` covers register → server → live chat → session
persistence; `web-voice.mjs` covers voice join, speaking rings from decoded audio,
mute propagation, screen share, webcam, pin (simulcast l→h re-subscribe), teardown.

```sh
# 1. build the web bundle against the local worker
VITE_API_BASE=http://localhost:8787 pnpm --filter tavern-app build
# 2. serve it (needs worker/.dev.vars with CF_APP_SECRET for the SFU)
pnpm dev:worker
# 3. run both specs (screenshots land in e2e/screenshots/)
pnpm --filter tavern-app test:e2e
```

Media comes from Chromium fakes: a generated 440 Hz tone as the mic (loud enough to
sustain the §1 speaking rule), the rolling-pattern fake webcam, and an auto-selected
screen for getDisplayMedia. Requires the full `chromium` channel
(`npx playwright install chromium`) — the headless shell has no media capture.
