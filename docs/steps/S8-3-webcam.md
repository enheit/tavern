# S8.3 — Webcam publish

- after: S8.2
- unlocks: S8.5
- FRs: FR-29 (+ FR-30 consistency for cam tiles)
- references: PLAN §1.5, §7.1 (track naming), §App-D (webcam row), §6.1

## Goal

A voice member toggles their webcam; it publishes as `cam:{userId}` with the pinned fixed preset
and appears on the canvas as a normal tile — opt-in to watch like any stream (pinned: webcams
follow FR-30 exactly; no auto-watch). The sharer sees a local self-preview tile without pulling.

## Preconditions (run these; red = STOP)

- `pnpm --filter @tavern/app test` → green (S8.2 landed)
- `grep -n "'webcam'" shared/src/protocol.ts` → `stream.start` kind union includes it

## Tasks

1. `useWebcam` hook: `start()` → `getUserMedia({ video: { width:{ideal:1280}, height:{ideal:720},
   frameRate:{ideal:30}, deviceId: {exact: settings.cameraDeviceId} when set } })` →
   `publishSession.publishCam(track)` (S7.2 — the engine applies the fixed webcam encodings from
   `WEBCAM_PRESET` (h 720p30/1000kbps) + `WEBCAM_LOW` (l 180p/15fps/150kbps) internally; returns
   `{ trackName }` = `cam:{userId}`) → WS `stream.start {kind:'webcam', trackName, preset:'720p30'}`
   (`720p30` is the existing `PresetId` matching the cam's dimensions — there is NO `cam*` id in the
   union; the real bitrate caps live in `WEBCAM_PRESET`/`WEBCAM_LOW`, not `SCREEN_PRESETS`).
   `stop()` → `stream.stop` + unpublish + track stop. One webcam per user (trackName has no
   counter — PLAN §7.1), second `start()` while active is a no-op.
2. ControlsBar Cam toggle button (idle/active states, same visual language as ScreenShare).
3. Self-preview (pinned): the sharer's own cam tile renders the LOCAL MediaStreamTrack directly —
   never a PullSession to self. `StreamTile` gains a `selfStream: MediaStream | null` prop path:
   when `stream.userId === self.userId`, Canvas passes the local stream and the tile renders it
   muted with a "You" badge; Watch button never renders for self tiles.
4. Camera device select added to the Settings → Voice section (S7.3's
   `VoiceSettingsSection.tsx`): `enumerateDevices()` `videoinput` list, persisted as
   `settings.cameraDeviceId`; switching while publishing = `current.stop()` → `getCam(newDeviceId)`
   (S7.2) → `sender.replaceTrack(newTrack)` (no renegotiation) — the FR-22 mic pattern applied to
   the camera. S7.2 has no cam-specific retoggle helper; `getCam(deviceId?)` is the pinned
   acquisition call.
5. Webcam encodings are `WEBCAM_PRESET`/`WEBCAM_LOW` in `shared/src/presets.ts` (S0.2, id-less
   consts) — never inline numbers. The WS `stream.start`/registry `preset` field carries the
   existing `PresetId` `720p30` (cam dims); do NOT invent a `cam720p30` id (the `PresetId` union
   has none, and `stream.start` with an unknown preset is rejected → close 1008).

## Pinned interfaces & artifacts

Files created: `app/src/features/streams/useWebcam.ts`.
Files modified: `app/src/features/shell/ControlsBar.tsx`, `app/src/features/streams/Canvas.tsx`
(self-stream pass-through), `app/src/features/streams/StreamTile.tsx` (self path),
`app/src/features/voice/VoiceSettingsSection.tsx` (camera device select),
`app/src/stores/settings.ts` (cameraDeviceId).

```ts
// app/src/features/streams/useWebcam.ts
useWebcam(): {
  active: boolean
  start(): Promise<void>
  stop(): Promise<void>
}
```

## Tests

- `app/src/features/streams/useWebcam.test.ts` — `describe('FR-29 webcam publish')`:
  `start calls publishSession.publishCam and publishes cam:{userId}`,
  `stream.start payload is kind webcam with preset 720p30`,
  `second start while active is a no-op (single cam pinned)`,
  `stop unpublishes, stops the track, sends stream.stop`,
  `device switch while active: stop → getCam → replaceTrack, no new offer`.
- `app/src/features/streams/StreamTile.test.tsx` (extend) — `describe('FR-29 self preview')`:
  `own cam tile renders local stream muted with You badge`,
  `own tiles never render a Watch button`,
  `remote cam tile renders placeholder + Watch (FR-30 applies to webcams)`.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm --filter @tavern/app test -- --coverage` → green; thresholds per §10
- [ ] `pnpm --filter @tavern/app exec tsc --noEmit` → exit 0
- [ ] `pnpm oxlint --deny-warnings && pnpm exec oxfmt --check .` → exit 0
- [ ] `node scripts/check-i18n-literals.mjs` → exit 0
- [ ] `grep -rn "FR-29" app/src/features/streams --include="*.test.*" | wc -l` → ≥2

## STOP conditions (beyond global R1)

- Publishing screen + webcam simultaneously on one PublishSession fails in the engine (S7.2
  contract says it must work — FR-29 AC) → blocker against S7.2, not a local workaround.

## Docs (consult only these)

- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- https://developers.cloudflare.com/realtime/sfu/https-api/
