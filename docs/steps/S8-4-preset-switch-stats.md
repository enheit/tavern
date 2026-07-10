# S8.4 — On-the-fly preset switching + watch-stats & meter wiring

- after: S8.2
- unlocks: S8.5, S10.2
- FRs: FR-27 (switch on the fly), FR-33 (layer↔meter), FR-40 (watch/stream seconds)
- references: PLAN §1.5, §7.2 (constraint rules), §8 (G5), §5.2 (stat tables), §App-D, S3.4 (injected clock)

> Note: c2s `stream.preset { trackName, preset }` and s2c `stream.updated { trackName, preset, at }`
> ALREADY exist in §App-A and in `shared/src/protocol.ts` (S0.2 defines them). This step does NOT
> touch the protocol package — it wires the DO/meter/UI to the existing frames. They matter because
> the DO's cost meter (G5) prices a watch by the publisher's CURRENT preset; a silent local encoder
> change would corrupt the meter.

## Goal

A sharer changes resolution/fps live without restarting the share or renegotiating viewers; the
DO always knows each stream's current preset and each watcher's current layer, so egress metering
(G5) and per-pair watch statistics (FR-40) are server-authoritative and correct.

## Preconditions (run these; red = STOP)

- `pnpm --filter @tavern/app test && pnpm --filter @tavern/worker test` → green
- `grep -n "stat_watch_seconds\|stat_stream_seconds" worker/src/do/sql.ts` → present (S3.4)
- `grep -n "egress_log" worker/src/do/costMeter.ts` → present (S7.1 meter API)
- `grep -n "stream.preset" shared/src/protocol.ts` → present (S0.2 already defines the two messages)

## Tasks

1. Sharer-side preset dropdown on OWN sharing tile (screen shares only; webcam preset is fixed):
   `setPreset(p)` in `useScreenShare` → in order: (a) `videoTrack.applyConstraints({ width:
   {ideal,max}, height:{ideal,max}, frameRate:{ideal,max} })` (ideal/max only, §7.2), (b)
   `sender.setParameters` updating ONLY the h-encoding's `maxBitrate`/`maxFramerate` from
   §App-D (l-encoding constants untouched), (c) WS `stream.preset {trackName, preset}`.
   No renegotiation, no track replacement — assert in tests.
2. DO: handle `stream.preset` → validate sender owns the stream + preset is a valid `PresetId` →
   update registry row → broadcast `stream.updated` → `costMeter.repriceStream(trackName,
   preset)` (open watch intervals are closed at the old rate and reopened at the new one — same
   accounting pattern as grant/release).
3. Viewer layer metering: S8.2's `setLayer(rid)` engine call now ALSO informs the worker —
   the existing `PUT /api/rtc/:serverId/renegotiate`-adjacent route from S7.1
   (`/api/rtc/:serverId/tracks/update`) already proxies `tracks/update`; extend its DO
   notification (`/internal/rtc/authorize` `op:'layer'`) so the meter prices that watcher at the
   l-rate (250kbps · dt) vs the h-rate (preset kbps · dt). Client sends it as part of
   `setLayer` — no new WS message (HTTP path already exists, pinned). (e2e: on each switch record
   `{trackName, rid}` into `window.__tavernTestRtc?.layerCalls` when `platform.isE2E`, for S8.5's
   FR-33 assertion — the `layerCalls` field extends S7.4's `__tavernTestRtc` hook.)
4. Stats flush wiring (FR-40): confirm-and-test only (accumulators were built in S3.4/S7.1):
   watch seconds accrue per `(viewer, streamer)` pair from grant→release/disconnect; stream
   seconds accrue from `stream.start`→`stop`/disconnect. This step adds the missing
   integration assertions and any glue found absent — if the S3.4 accumulator API cannot express
   an operation, STOP (blocker against S3.4), don't fork logic here.
5. Testability pin: DO modules take an injected clock (explicit `at`/`now` params) — S3.4 pinned
   this; meter tests drive time explicitly, never `sleep`.
6. Resize-driven layer re-evaluation: NOT in v1 (pinned) — only focus/unfocus switches layers.

## Pinned interfaces & artifacts

Files modified: `app/src/features/streams/`
(`useScreenShare.ts` setPreset, `StreamTile.tsx` preset dropdown for own screen tiles),
`app/src/media/rtc/pullSession.ts` (setLayer → HTTP notify), `worker/src/do/ServerRoom.ts`
(route `stream.preset`), `worker/src/do/costMeter.ts` (`repriceStream`, `setWatcherLayer`),
`worker/src/do/stats.ts` (assert-only or glue), `worker/src/routes/rtc.ts` (layer notify).

```ts
// Already in shared/src/protocol.ts (S0.2) — verify, do NOT redefine:
{ t: 'stream.preset', trackName: string, preset: PresetId }            // c2s
{ t: 'stream.updated', trackName: string, preset: PresetId, at: number } // s2c

// costMeter.ts additions
repriceStream(trackName: string, preset: PresetId): void
setWatcherLayer(viewerId: string, trackName: string, rid: 'h' | 'l'): void
```

Meter math stays §App-D single-source: `bytes = kbps * 1000 / 8 * dtSeconds` (kbps is decimal).

## Tests

- `app/src/features/streams/useScreenShare.test.ts` (extend) — `describe('FR-27 on-the-fly
  preset switch')`: `setPreset applies ideal/max constraints then setParameters on h only`,
  `no renegotiation occurs (fake signal layer records zero offers)`,
  `stream.preset sent after successful local switch`, `dropdown only on own screen tiles`.
- `worker/test/do/preset-meter.test.ts` (default project, injected clock — pure meter math) —
  `describe('FR-27 preset repricing')`:
  `720p30 watcher on h meters 9_000_000 bytes per 60s tick (1200kbps)`,
  `same watcher on l meters 1_875_000 bytes per 60s (250kbps)` (exact numbers, injected clock),
  `reprice mid-interval splits accounting at the switch timestamp`.
- `worker/test/ws/preset.spec.ts` (test:ws project — needs a live DO WebSocket) —
  `describe('FR-27 preset guard')`:
  `stream.preset from non-owner → error{code:'bad_message'} and no reprice`.
- `worker/test/do/watch-stats.test.ts` — `describe('FR-40 watch/stream seconds')`:
  `grant→release accrues pair seconds server-side`, `disconnect closes open watch intervals`,
  `stream stop accrues streamer seconds`, `GET /api/servers/:id/stats reflects both`.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm --filter @tavern/shared test` → green (protocol round-trip covers stream.preset/stream.updated — defined in S0.2)
- [ ] `pnpm --filter @tavern/worker test -- --coverage` → green; worker ≥80%
- [ ] `pnpm --filter @tavern/worker test:ws` → exit 0 (preset guard WS spec)
- [ ] `pnpm --filter @tavern/app test` → green
- [ ] `pnpm oxlint --deny-warnings && pnpm exec oxfmt --check .` → exit 0
- [ ] `grep -rn "FR-40" worker/test --include="*.test.*" | wc -l` → ≥1

## STOP conditions (beyond global R1)

- S3.4/S7.1 accumulator or meter APIs can't express reprice/layer ops without schema change →
  blocker naming the exact missing operation.
- `applyConstraints` on the live display track throws for legal ideal/max values → blocker with
  the Chromium error text (do not fall back to re-capturing — that restarts the share, violating
  FR-27's AC).

## Docs (consult only these)

- https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/applyConstraints
- https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters
- https://developers.cloudflare.com/realtime/sfu/simulcast/ (tracks/update)
