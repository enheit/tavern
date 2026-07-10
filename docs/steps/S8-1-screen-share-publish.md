# S8.1 — Screen share publish (picker, presets, loopback audio, simulcast)

- after: S7.3
- unlocks: S8.2
- FRs: FR-27 (publish side), FR-28
- references: PLAN §1.5, §7.1, §7.2, §8 (G2/G3/G4), §App-B, §App-D, §3.7 (macOS loopback fallback), §6.3 (IPC capture)

## Goal

A voice member can start/stop sharing a screen or window with a pinned quality preset and (where
the OS supports it) system audio, published to the SFU as two simulcast layers. No viewer work in
this step — S8.2 consumes what this publishes.

## Preconditions (run these; red = STOP)

- `pnpm --filter @tavern/app test` → green (S7.3 landed: engine + voice UI)
- `grep -n "publishStream" app/src/media/rtc/publishSession.ts` → present (S7.2 interface)
- `grep -n "loopbackAudioSupported" shared/src/ipc.ts` → present

## Tasks

1. Add `captureScreen` to `app/src/media/capture.ts` (platform-split via the S4.3 bridge):
   desktop = `platform.capture.selectSource(sel.sourceId)` to arm the main-process handler, then
   `getDisplayMedia({ video: {width:{ideal,max}, height:{ideal,max}, frameRate:{ideal,max}} from
   preset, audio: sel.withAudio })`; web = `getDisplayMedia` directly (native picker). Only
   `ideal`/`max` constraint keys — `min`/`exact` throw on display capture (PLAN §7.2).
2. Build `SharePickerDialog` (desktop variant: Screens/Windows tabs of thumbnails from
   `platform.capture.getScreenSources()`, preset `Select` defaulting `1080p30`, "Share audio"
   `Switch` enabled iff `await platform.capture.loopbackAudioSupported()`; web variant: preset +
   audio hint only, source chosen by the browser). Hidden entirely: the audio switch on Linux v1
   (pinned — experimental flag only, no UI).
3. Implement `useScreenShare`: `start(sel)` → `captureScreen(sel)` → publish via S7.2's frozen
   signature `const { videoTrackName, audioTrackName } = await publishSession.publishStream(video,
   audio, preset)`. PublishSession OWNS track naming and the per-share `n` counter — it generates
   `screen:{userId}:{n}` / `screenAudio:{userId}:{n}` (n starts at 1 and increments per share start,
   so a stop/start yields NEW names, PLAN §7.1) and applies the §App-D h/l encodings for the preset;
   `useScreenShare` passes NO kind/names argument and computes no names. Store the returned names,
   then send WS `stream.start {kind:'screen', trackName: videoTrackName, audioTrackName?, preset}`.
4. Stop paths (both must work): capture `track.onended` (OS/browser stop button) AND ControlsBar
   toggle → WS `stream.stop {trackName}` + `publishSession.unpublish` for video and audio tracks.
5. ControlsBar ScreenShare button: `idle` ↔ `sharing` (pulsing accent ring) states; click while
   sharing = stop, while idle = open picker.
6. Self-audio caveat (FR-28 pinned limitation): first time a share starts with audio, show a
   sonner toast with i18n key `streams.selfAudioCaveat` (→ flat `streams_self_audio_caveat` in
   `app/messages/{en,uk}.json` per §9.6; call as `m.streams_self_audio_caveat()`). en: "Shared
   audio includes all system sound — Tavern voices and soundboard will be heard in your stream.";
   uk: "Звук трансляції включає весь системний звук — голоси та саундборд Tavern буде чутно у вашій
   трансляції." One-shot via localStorage key `tavern.selfAudioCaveatShown.v1`.
7. macOS loopback probe (DoD manual gate): run the dev app on macOS, share with audio, verify the
   audio track is live (`track.readyState === 'live'` + level meter moves with system sound).
   Record evidence in `docs/progress.md`. If no audio: execute PLAN §3.7 row (darwin →
   `loopbackAudioSupported() = false`, informational blocker), do not debug further.

## Pinned interfaces & artifacts

Files created: `app/src/features/streams/{SharePickerDialog.tsx, useScreenShare.ts, types.ts}`
(types.ts holds the app-local `ShareSelection`), plus the three colocated test files
`app/src/features/streams/{useScreenShare.test.ts, SharePickerDialog.test.tsx, selfAudioCaveat.test.ts}`.
i18n keys added to `app/messages/{en,uk}.json` (snake_case `streams_self_audio_caveat`).
Files modified: `app/src/media/capture.ts`, `app/src/features/shell/ControlsBar.tsx`,
`app/src/stores/media.ts` (share state slice).

```ts
// shared ShareSelection lives in app/src/features/streams/types.ts (app-local, not protocol)
type ShareSelection = { sourceId: string | null; preset: PresetId; withAudio: boolean }

// app/src/media/capture.ts (addition)
captureScreen(sel: ShareSelection): Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null }>

// app/src/features/streams/useScreenShare.ts
useScreenShare(): {
  sharing: boolean
  preset: PresetId | null
  trackName: string | null
  start(sel: ShareSelection): Promise<void>
  stop(): Promise<void>
}

// SharePickerDialog.tsx props
{ open: boolean; onOpenChange(open: boolean): void; onStart(sel: ShareSelection): void }
```

Encodings (verbatim from `shared/src/presets.ts`, §App-D): h = selected preset
maxBitrate/maxFramerate, l = `scaleResolutionDownBy` to ≈270 height, 15fps, 250kbps. Every
encoding carries `maxBitrate` — a missing one is a review-blocking bug (G2).

## Tests

- `app/src/features/streams/useScreenShare.test.ts` — `describe('FR-27 screen share publish')`:
  `start publishes h+l encodings from the preset table`, `start sends stream.start with
  audioTrackName only when audio granted`, `track names increment per share (n=1 then n=2)`,
  `onended sends stream.stop and unpublishes both tracks`, `manual stop mirrors onended path`,
  `start rejects when engine publish fails and leaves state idle`.
- `app/src/features/streams/SharePickerDialog.test.tsx` — `describe('FR-28 share picker')`:
  `desktop: selecting a source arms selectSource with its id`, `preset select exposes exactly the
  12 §App-D presets, default 1080p30`, `audio switch disabled when loopbackAudioSupported=false`,
  `audio switch absent on linux`, `web: no source grid rendered`.
- `app/src/features/streams/selfAudioCaveat.test.ts` — `describe('FR-28 self-audio caveat')`:
  `toast fires once then never again (localStorage flag)`.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm --filter @tavern/app test -- --coverage` → green; `app/src/media` ≥85% lines
- [ ] `pnpm --filter @tavern/app exec tsc --noEmit` → exit 0
- [ ] `pnpm oxlint --deny-warnings && pnpm exec oxfmt --check .` → exit 0
- [ ] `node scripts/check-i18n-literals.mjs` → exit 0 (new UI strings via i18n keys)
- [ ] `grep -rn "FR-27\|FR-28" app/src/features/streams --include="*.test.*" | wc -l` → ≥3
- [ ] macOS loopback probe evidence appended to `docs/progress.md` (or §3.7 fallback executed and
      recorded) — this gate is manual-evidence, per repo rule "visual results count"

## STOP conditions (beyond global R1)

- `getDisplayMedia` returns no audio track on Windows with `audio:'loopback'` armed → blocker
  (Windows is the in-box guarantee; do NOT ship silently video-only there).
- `publishStream` requires renegotiation semantics not covered by S7.2's interface → blocker
  (don't extend the engine ad hoc).

## Docs (consult only these)

- https://www.electronjs.org/docs/latest/api/session (setDisplayMediaRequestHandler, loopback)
- https://www.electronjs.org/docs/latest/api/desktop-capturer
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- https://developers.cloudflare.com/realtime/sfu/simulcast/
