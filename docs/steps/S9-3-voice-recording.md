# S9.3 — Voice recording

- after: S7.3 (voice live, audio graph, S7.2 recorder seam), S3.3 (activity log), S7.4 (e2e fast-alarm + SFU mock)
- unlocks: S12.3
- FRs: FR-25
- references: PLAN §1.4 (FR-25 AC), §5.2, §5.3, §6.1, §7.4 (pinned recording mechanics), §App-A, §App-B

## Goal

Any voice member can start/stop a recording of the call. The recorder's client mixes all remote
voices + own mic (+ soundboard — pinned: it is part of the call ambience) via WebAudio into a
`MediaRecorder` opus/webm stream, uploaded as R2 multipart parts while recording. One active
recording per server, a red REC indicator for everyone in voice, start/stop in the activity log,
recordings listed and playable in-app.

## Preconditions (run these; red = STOP)

- `pnpm -F @tavern/worker test && pnpm -F @tavern/app test` → exit 0
- `grep -n "rec.start\|rec.state" shared/src/protocol.ts` → non-empty
- `grep -n "recordingPartBytes" shared/src/limits.ts` → `5_242_880`
- `grep -n "mixForRecording" app/src/media/audioGraph.ts` → non-empty (S7.2 seam)

## Tasks

1. **DO state machine** (`worker/src/do/recordings.ts` + `ServerRoom.ts` router):
   - c2s `rec.start {}`: sender must be in voice → else `error{code:'not_in_voice'}`; an active
     recording exists → `error{code:'already_recording'}`; else INSERT `recordings` row
     (`id = crypto.randomUUID()`, `started_by`, `started_at`, `r2_key =
     'recordings/{serverId}/{recordingId}.webm'`, `upload_id = NULL` until opened), broadcast
     `rec.state { active:true, recordingId, startedBy, startedAt }`, append activity `rec.start`.
   - c2s `rec.stop {}` (starter only): broadcast `rec.state { active:false }` immediately
     (indicator drops for everyone), append activity `rec.stop`; the ROW finalizes later via the
     REST `complete` call (App-A: "rec.stop finalizes via REST; WS just flips state").
   - Dirty end (starter's sockets all close OR starter leaves voice while active, without a prior
     graceful stop): cancel — abort the R2 multipart via the DO's `MEDIA` binding
     (`resumeMultipartUpload(key, uploadId).abort()`), DELETE the row, broadcast
     `rec.state { active:false }`, append activity `rec.stop` with `meta: {"aborted":true}`.
   - `/internal/recordings/finalize { recordingId, durationMs }` (from Worker `complete`):
     set `ended_at = now`, `duration_ms = min(durationMs, LIMITS.recordingMaxDurationMs)`, clear
     `upload_id`.
2. **Worker multipart routes** (`worker/src/routes/recordings.ts`, §6.1 + amendments):
   - `POST /api/servers/:id/recordings` (member-in-voice; only valid while DO shows this user as
     the active starter) → `MEDIA.createMultipartUpload(r2Key)` → store `upload_id` on the row →
     `{ recordingId, uploadId }`.
   - `PUT /api/servers/:id/recordings/:recId/part?n=<int>&uploadId=<id>&final=<0|1>` (starter
     only): stream the request body to `uploadPart(n)`; if `final=0`, require
     `Content-Length === LIMITS.recordingPartBytes` → else 400 `bad_part_size`; reject when
     elapsed since `started_at` exceeds `recordingMaxDurationMs + 300_000` grace → 422
     `recording_too_long`. Response `{ etag }`.
   - `POST .../recordings/:recId/complete { parts: {partNumber, etag}[], durationMs }` (starter) →
     `upload.complete(parts)` → DO finalize.
   - `POST .../recordings/:recId/abort` (starter) → R2 abort + DO cancel path.
   - `GET /api/servers/:id/recordings` (member) → list, newest first.
   - `DELETE /api/servers/:id/recordings/:recId` (starter or admin) → R2 delete + row delete.
3. **Client recorder** (`app/src/media/recorder.ts` — fill the S7.2-frozen `VoiceRecorder` /
   `RecorderChunkSink` shapes below; S7.2 created the stub): `VoiceRecorder.start(localMic, sink)`
   builds the mix via `this.graph.mixForRecording(localMic)`, opens `MediaRecorder(mix, { mimeType:
   'audio/webm;codecs=opus' })` (guard `MediaRecorder.isTypeSupported` at construction),
   `mediaRecorder.start(LIMITS.recordingTimesliceMs)`; `ondataavailable` blobs append to a byte
   queue; whenever queued bytes ≥ `recordingPartBytes`, slice EXACTLY `recordingPartBytes` and hand
   it to `sink.onPart(n, bytes, false)`. `VoiceRecorder.stop()` flushes remaining bytes via
   `sink.onPart(n, rest, true)` and resolves `{ durationMs }` (measured). All R2 upload/retry/etag
   logic lives in the `RecorderChunkSink` implementation (`R2MultipartSink` below): parts uploaded
   sequentially, one in-flight, failed part retried ×3 with 1 s/2 s/4 s backoff then `abort()` +
   state `'error'`; it opens the multipart lazily on the first part and, once the caller passes
   `durationMs` from `stop()`, calls `complete`.
4. **Mix** : `audioGraph.mixForRecording(localMic: MediaStreamTrack): MediaStream` (S7.2 signature —
   the caller passes the live mic track) taps all per-user gains PRE-deafen + own mic + `sbGain`
   (soundboard included — pinned); `releaseRecordingMix()` (additive to audioGraph) on stop/error.
5. **UI**: ControlsBar Record toggle (enabled only in voice; while active and owned by self →
   stop). Red pulsing `REC` chip with starter's name, rendered for every client whose
   `rec.state.active` is true and who is in voice (chip lives in the ControlsBar area; also a dot
   on the Channels-panel voice row) — FR-25's "visible to ALL voice members". Recordings tab
   (§7.6 right-column tabs), mounted in `app/src/features/chat/ChatTabs.tsx` (replacing its S6.1
   placeholder): rows = starter avatar/name, start date, `mm:ss` duration (from
   metadata — recorded webm has no cues, §7.4; seeking is best-effort, no UI note), Play →
   `<audio>` streaming `GET /api/media/recordings/…`, Delete for starter/admin with confirm.
   Voice-leave while recording (graceful): UI auto-runs stop-and-complete BEFORE `voice.leave`.
6. Wire e2e fast path: `.dev.vars.e2e` sets `TAVERN_TEST_FAST_ALARM=1` (S7.4 convention) — no new
   mechanism here.

## Pinned interfaces & artifacts

Files created: `worker/src/do/recordings.ts`, `worker/src/routes/recordings.ts`,
`app/src/features/recordings/{RecordingsTab,RecordButton}.tsx`, `e2e/web/recording.spec.ts`.
Modified: `app/src/media/recorder.ts` (S7.2 created the stub — S9.3 fills the body),
`worker/src/do/ServerRoom.ts`, `worker/src/index.ts`, `app/src/media/audioGraph.ts` (additive:
`releaseRecordingMix`), `app/src/features/shell/ControlsBar.tsx`,
`app/src/features/chat/ChatTabs.tsx` (mount RecordingsTab, replacing its S6.1 placeholder).
`Recording` / `RecordingsResponse` / `OpenRecordingResponse` / `UploadPartResponse` /
`CompleteRecordingRequest` already live in `shared/src/api.ts` from S0.2 — reuse verbatim, do NOT
touch that file. The `recordings` table already carries `upload_id` (§5.2 / S3.1) and the DO
reaches R2 via its constructor `env.MEDIA` (binding present since S1.1) — no schema or wrangler change.

```ts
// app/src/media/recorder.ts — implements S7.2's FROZEN shapes (do NOT redefine):
//   interface RecorderChunkSink { onPart(partNumber: number, bytes: Uint8Array, isFinal: boolean): Promise<void> }
//   class VoiceRecorder { constructor(deps: { graph: AudioGraph }); start(localMic: MediaStreamTrack, sink: RecorderChunkSink): void; stop(): Promise<{ durationMs: number }>; readonly active: boolean }

// S9.3 ADDS the R2 multipart sink + upload API (the open / uploadId-holding wiring):
export type RecorderState = 'idle' | 'recording' | 'finishing' | 'error'
export interface RecordingUploadApi {
  open(): Promise<{ recordingId: string; uploadId: string }>   // POST /api/servers/:id/recordings
  uploadPart(recordingId: string, n: number, bytes: Uint8Array, final: boolean): Promise<{ etag: string }>
  complete(recordingId: string, parts: { partNumber: number; etag: string }[], durationMs: number): Promise<void>
  abort(recordingId: string): Promise<void>
}
export class R2MultipartSink implements RecorderChunkSink {  // opens lazily on the first onPart, holds uploadId + collected {partNumber, etag}
  constructor(api: RecordingUploadApi, onState: (s: RecorderState) => void)
  onPart(partNumber: number, bytes: Uint8Array, isFinal: boolean): Promise<void>  // uploadPart with ×3 retry; abort()+onState('error') on give-up
  finish(durationMs: number): Promise<void>   // caller passes durationMs from VoiceRecorder.stop() → api.complete
  readonly recordingId: string | null
}
```

Recording list/detail schemas: use S0.2's `Recording` / `RecordingsResponse` verbatim
(`Recording = { id, startedBy, startedAt, endedAt: int|null, durationMs: int|null }`).

Error codes used (must already exist in `shared/src/errors.ts` — a missing one is S0.2 drift, STOP):
`not_in_voice`, `already_recording`, `bad_part_size`, `recording_too_long`, `forbidden`, `not_found`.

## Tests

`worker/test/recording-state.spec.ts` (WS project) — `describe('FR-25 recording state machine')`:
1. `rec.start while not in voice → not_in_voice`
2. `rec.start creates row, broadcasts active rec.state, appends activity rec.start`
3. `second rec.start → already_recording`
4. `rec.stop broadcasts inactive; complete finalizes row with duration capped at recordingMaxDurationMs`
5. `starter disconnect while active → row deleted, multipart aborted, inactive broadcast, activity meta aborted`
6. `alarm/idempotency: repeated dirty-end handling does not double-append activity`

`worker/test/recording-upload.spec.ts` — `describe('FR-25 multipart upload')`:
1. `non-final part with wrong Content-Length → 400 bad_part_size`
2. `open→parts→complete produces an object readable via /api/media with correct byte length`
3. `abort removes the row and R2 shows no object`
4. `part upload by a non-starter member → 403`

`app/test/media/recorder.test.ts` (fake MediaRecorder + fake api) —
`describe('FR-25 recorder part slicing')`:
1. `VoiceRecorder slices exactly recordingPartBytes at the boundary (queued 5MiB+1 → one full part via sink.onPart, 1 byte remains)`
2. `accumulates multiple timeslices into sequential sink.onPart calls, one in-flight at a time`
3. `stop flushes a smaller final part (isFinal); sink.finish(durationMs) calls api.complete`
4. `R2MultipartSink part failure retries 3x then aborts and enters error state`

`app/test/recordings/RecordingsTab.test.tsx` — `describe('FR-25 recordings tab')`:
`lists newest first with mm:ss from metadata`, `delete visible only to starter or admin`.

`e2e/web/recording.spec.ts` — `describe('FR-25 recording e2e')` (two contexts in voice, tone WAV):
1. `A starts recording → B sees red REC chip and activity entry`
2. `after 6s A stops → recording listed with durationMs ≥ 5000` (FR-25 AC)
3. `B plays the recording → audio element reaches readyState ≥ 2 and non-zero duration display`
4. `A leaves voice mid-recording → recording finalizes (graceful path) and appears in the list`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/worker test` → exit 0
- [ ] `pnpm -F @tavern/app test` → exit 0
- [ ] `pnpm -F @tavern/e2e exec playwright test web/recording.spec.ts` → all passed
- [ ] `pnpm typecheck && pnpm lint` → exit 0
- [ ] `grep -rl "FR-25" worker/test app/test e2e/web | wc -l` → ≥ 4

## STOP conditions (beyond global R1)

- `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')` is false in the pinned Electron 43 /
  Chromium 150 runtime.
- R2 rejects the equal-parts scheme as designed (e.g. part-size validation error on `complete`
  despite equal non-final parts) — do not pad or re-chunk creatively; blocker.
- The DO cannot hold an R2 binding in this wrangler version (contradicts §3 research) — blocker,
  do not fall back to fire-and-forget Worker cleanup silently.

## Docs (consult only these)

- https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
- https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/
- https://www.w3.org/TR/mediastream-recording/ (chunk-concatenation guarantee)
