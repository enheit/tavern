# S8.2 — Watch/unwatch, canvas tiles, auto-layout, focus mode, per-stream volume

- after: S8.1
- unlocks: S8.3, S8.4
- FRs: FR-30, FR-31, FR-32, FR-33 (viewer side)
- references: PLAN §1.5, §7.1 (watchPC, tracks/update), §7.3 (audio graph), §8 (G1/G3), §App-C

## Goal

Streams appear as tiles on the Canvas laid out exactly per §App-C. Nothing is received until a
user clicks Watch (G1); watched tiles render video (+audio through its own gain node); a focused
tile pulls the high simulcast layer; every watched-with-audio tile has an independent volume.

## Preconditions (run these; red = STOP)

- `pnpm --filter @tavern/app test` → green (S8.1 landed)
- `pnpm --filter @tavern/shared test` → green (`computeLayout` locked by S0.2 unit tests)
- `grep -n "class PullSession\|setLayer" app/src/media/rtc/pullSession.ts` → present (S7.2 pins
  `class PullSession` with `addRemoteTracks(...)` and `setLayer(trackName, rid)`)

## Tasks

1. `useWatch(stream)` hook: `watch()` → send WS `watch.start {trackName}`, then **immediately**
   create a dedicated PullSession (one per watched stream, PLAN §7.1) pulling video (+audio when
   `stream.hasAudio`) → expose `mediaStream`. There is no wire grant ack (App-A has no
   `watch.start` response; S7.1 checks the grant server-side when the REST pull arrives) — the flow
   is fire-and-forget; a `pull_denied`/`cost_cap` error frame or a failed REST pull transitions
   state back to `'idle'`. `unwatch()` → close PullSession + WS `watch.stop`. Auto-unwatch on
   `stream.removed` for the same trackName. Audio track routes into
   `audioGraph.attachStreamAudio(streamKey, new MediaStream([track]))` — S7.2 pins the second arg
   as a `MediaStream`, not a track (`streamKey = ${userId}:${kind}`, the same opaque key used for
   `setStreamGain`; S7.2's param name `trackName` notwithstanding). The muted `<audio>`
   flow-starter per §7.3 is the graph's job, not the hook's.
2. `StreamTile`: placeholder state (streamer avatar + display name in their color, kind icon,
   Watch button — FR-30) vs watching state (`<video autoplay muted playsInline>` fed by
   `mediaStream`, `object-fit: contain` letterbox in a 16:9 box, unwatch button + volume slider
   on hover when `hasAudio`). Slider 0–200% → `audioGraph.setStreamGain(streamKey, gain)`;
   persisted under `settings.volumes.v1` keyed by `${userId}:${kind}` (trackNames rotate per
   share — the key must survive restarts, pinned).
3. `Canvas`: reads `streams` from the room store, computes rows via
   `computeLayout(streams.length, canvasW, canvasH)` (ResizeObserver on the canvas element),
   renders CSS grid per row: container = flex column with 8px gap, each row = CSS grid
   `grid-template-columns: repeat(<count>, 1fr)` with 8px gap, row height = `1fr` of the column
   flex. Tile order = `stream.trackName` ascending (stable, pinned).
4. Focus mode (FR-33): double-click a WATCHED tile → focused layout: flex row — focused tile
   `flex: 1`, all other tiles collapse into a vertical right strip `width: 160px`
   (scroll-y, 8px gap). Entering focus → `useWatch.setLayer('h')` (engine → PUT `tracks/update`
   `{simulcast:{preferredRid:'h'}}`); leaving (Esc or double-click again) → `setLayer('l')` and
   grid layout restores. Exactly one focused tile at a time (room-store field
   `focusedTrackName: string | null`).
5. Grid tiles always pull `'l'` (initial pull request pins `preferredRid:'l'`, G3). Voice-only
   users with zero watches create zero PullSessions (G1) — assert in tests.
6. Layer changes notify the DO for metering via the existing WS `watch.start` grant? No — layer
   metering lands in S8.4; this step only calls the engine. (Pinned scope split.)
7. i18n keys (both locales — every user-visible string this step renders; §9.6 maps dotted names
   to flat snake_case in `app/messages/{en,uk}.json`):

   | key | en | uk |
   |---|---|---|
   | streams.watch | Watch | Дивитися |
   | streams.unwatch | Stop watching | Зупинити перегляд |
   | streams.volume | Volume | Гучність |

## Pinned interfaces & artifacts

Files created: `app/src/features/streams/{Canvas.tsx, StreamTile.tsx, useWatch.ts}` plus the three
colocated test files `app/src/features/streams/{useWatch.test.ts, Canvas.test.tsx,
StreamTile.test.tsx}`, and i18n keys added to `app/messages/{en,uk}.json`.
Files modified: `app/src/stores/room.ts` (focusedTrackName), `app/src/stores/settings.ts`
(stream volume map), `app/src/media/audioGraph.ts` (only if `attachStreamAudio`/`setStreamGain`
were stubbed in S7.2 — signatures below are already pinned there).

```ts
// app/src/features/streams/useWatch.ts
useWatch(stream: StreamInfo): {
  state: 'idle' | 'connecting' | 'watching'
  mediaStream: MediaStream | null
  watch(): void
  unwatch(): void
  setLayer(rid: 'h' | 'l'): void
}
// StreamTile.tsx props
{ stream: StreamInfo; focused: boolean; onToggleFocus(): void }
// Canvas.tsx props: none (store-driven)
```

## Tests

- `app/src/features/streams/useWatch.test.ts` — `describe('FR-30 opt-in watching')`:
  `no PullSession exists before watch()`, `watch() sends watch.start then creates one
  PullSession pulling preferredRid l`, `hasAudio pulls audio track and attaches to graph`,
  `unwatch() closes session and sends watch.stop`, `stream.removed while watching auto-unwatches`,
  `grant error surfaces typed store status and returns to idle`.
- `app/src/features/streams/Canvas.test.tsx` — `describe('FR-32 canvas auto-layout')`:
  `3 streams render rows [2,1] per App-C`, `6 streams render [3,3]`, `tile order is trackName
  ascending`, `resize recomputes rows via computeLayout args` (assert the mock got new w/h).
- `app/src/features/streams/StreamTile.test.tsx` — `describe('FR-31 per-stream volume')`:
  `slider maps 0–200% to setStreamGain 0–2 keyed by userId:kind`, `volume persists to
  settings.volumes.v1`, `slider absent when hasAudio=false`; `describe('FR-33 focus layer')`:
  `double-click watched tile enters focus and calls setLayer h`, `second double-click (or Esc)
  leaves focus, calls setLayer l and restores grid`.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm --filter @tavern/app test -- --coverage` → green; `app/src` ≥70%, `app/src/media` ≥85%
- [ ] `pnpm --filter @tavern/app exec tsc --noEmit` → exit 0
- [ ] `pnpm oxlint --deny-warnings && pnpm exec oxfmt --check .` → exit 0
- [ ] `node scripts/check-i18n-literals.mjs` → exit 0
- [ ] `grep -rn "FR-3[0-3]" app/src/features/streams --include="*.test.*" | sort -u | wc -l` → ≥4

## STOP conditions (beyond global R1)

- The SFU grant flow (S7.1 worker routes) lacks anything `useWatch` needs (e.g. publisher
  sessionId for the pull) → blocker; do not add worker routes in this step.
- `computeLayout`'s row output can't express the focused layout → it shouldn't (focus mode is a
  separate flex layout, not a computeLayout case). If you find yourself editing
  `shared/src/layout.ts`, STOP — its table is test-locked.

## Docs (consult only these)

- https://developers.cloudflare.com/realtime/sfu/simulcast/ (tracks/update, preferredRid)
- https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver
