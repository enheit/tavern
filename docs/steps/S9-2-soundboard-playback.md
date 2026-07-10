# S9.2 — Soundboard: playback, stats, volume

- after: S9.1, S7.3 (audio graph + voice UI live), S7.4 (`__tavernTestAudio` hook)
- unlocks: S12.3
- FRs: FR-36, FR-37, FR-38
- references: PLAN §1.6, §5.2, §7.3, §7.4 (pinned playback mechanics), §App-A, §App-B

## Goal

Pressing a sound plays it for every voice member "simultaneously" via a broadcast event — each
client fetches and plays locally through its own soundboard gain (never through WebRTC). Every
play is recorded (who/when), the panel shows live play counts, and a dedicated volume slider
controls only soundboard output.

## Preconditions (run these; red = STOP)

- `pnpm -F @tavern/worker test && pnpm -F @tavern/app test` → exit 0 (S9.1, S7.3 green)
- `grep -n "sound.play\b" shared/src/protocol.ts` → non-empty
- `grep -n "sbGain" app/src/media/audioGraph.ts` → non-empty (S7.2 graph slot exists)

## Tasks

1. DO (`soundboard.ts` + `ServerRoom.ts` router): handle c2s `sound.play {soundId}`:
   token-bucket rate limit `LIMITS.rateSoundPlayPerSec` (1/s, per user, in-memory per DO) → over limit
   `error{code:'rate_limited'}`; unknown soundId → `error{code:'not_found'}`; else INSERT into
   `sound_plays` and broadcast s2c `sound.played { soundId, byUserId, at }` to ALL sockets.
   Sender gets no special-case — it plays on its own broadcast receipt (single code path, tight
   sync).
2. `app/src/media/soundboardPlayer.ts` — fill the S7.2-created `SoundboardPlayer` stub (S7.2 owns
   the class signature; S9.2 implements the body):
   - `fetchSound(soundId)` fetches mp3 bytes from `GET /api/media/sounds/{serverId}/{soundId}.mp3`
     through the Cache API, cache name `'tavern-sounds'` (no manual eviction — browser-managed);
     the R2 key is derived from `serverId + soundId` inside `fetchSound`;
   - `decodeAudioData` per play, buffer released after (§7.4 — NO decoded-buffer cache);
   - hand the decoded buffer to `graph.playSoundboard(buffer, trimStartMs, trimEndMs)` — the
     `AudioBufferSourceNode` → `sbGain` wiring lives in the AudioGraph (S7.2), not here;
   - concurrent/overlapping plays allowed (Discord-style) — the graph tracks live source nodes;
   - `stopAll()` (extends the S7.2 stub) cuts live soundboard sources via `graph.stopSoundboard()`
     on deafen-on and on voice leave.
3. Room store wiring: on `sound.played` → always bump the sound's `playCount` in the query cache
   (live badge, NO reorder); play audio ONLY if `inVoice && !deafened`. Reordering happens only on
   refetch triggered by `sound.updated` (deterministic list churn).
4. Panel header volume slider (FR-38): 0–200% → `audioGraph.setSoundboardGain(percent/100)`,
   persisted in `settings.volumes.v1` (localStorage, §7.3) — independent of user and stream gains.
5. E2E hook (S7.4's `__tavernTestAudio` contract — the `soundboardPlays: Array<{soundId, at}>`
   field is added to S7.4's `testHooks.ts`): when `platform.isE2E`, the player records
   `window.__tavernTestAudio?.soundboardPlays.push({ soundId, at: Date.now() })` instead of relying
   on audible output.

## Pinned interfaces & artifacts

Files created: `e2e/web/soundboard.spec.ts`.
Modified: `app/src/media/soundboardPlayer.ts` (S7.2 created the stub — S9.2 fills the body),
`worker/src/do/soundboard.ts`, `worker/src/do/ServerRoom.ts`,
`app/src/features/soundboard/SoundboardPanel.tsx`, `app/src/stores/room.ts`,
`app/src/media/audioGraph.ts` (additive: `stopSoundboard()` to cut live soundboard sources;
`playSoundboard`/`setSoundboardGain` already exist from S7.2). The `soundboardPlays` e2e field
lives on S7.4's `__tavernTestAudio` hook (S9.2 consumes it — see Task 5).

```ts
// app/src/media/soundboardPlayer.ts — implements the S7.2-frozen class (do NOT redefine the
// constructor/play signatures; this step fills the body and adds stopAll):
export class SoundboardPlayer {
  constructor(deps: { graph: AudioGraph; fetchSound: (soundId: string) => Promise<ArrayBuffer> });
  play(sound: { id: string; trimStartMs: number; trimEndMs: number }): Promise<void>;
  stopAll(): void;   // extends S7.2's stub — S7.2 owns SoundboardPlayer; add there if absent
}
```

WS frames (already in `shared/src/protocol.ts`; verify exact fields):
c2s `sound.play { soundId: string }` · s2c `sound.played { soundId, byUserId, at }` ·
s2c `sound.updated { at }`.

Error codes used: `rate_limited`, `not_found` (must already exist in `shared/src/errors.ts` —
a missing one is S0.2 drift, STOP).

Pinned behaviors: sender plays on broadcast (not on click); non-voice members update counts but
never play; deafen stops in-flight soundboard audio AND suppresses new plays until undeafened.

## Tests

`worker/test/ws/soundboard-play.spec.ts` (test:ws project, `--max-workers=1 --no-isolate`) —
`describe('FR-36 sound.play')`:
1. `play inserts sound_plays row and broadcasts sound.played to all sockets`
2. `second play within 1s from same user → rate_limited error, no row`
3. `unknown soundId → not_found`
4. `describe('FR-37 stats')`: `playCount in GET sounds reflects sound_plays rows`

`app/test/media/soundboardPlayer.test.ts` (fake AudioGraph) — `describe('FR-36 soundboard player')`:
1. `play decodes then calls graph.playSoundboard(buffer, 1200, 3500) for trim 1200..3500`
2. `allows two overlapping plays; stopAll calls graph.stopSoundboard`
3. `fetches bytes once for repeated plays (Cache API hit), decodes each time`
4. `deafen stopAll leaves no live sources (graph.stopSoundboard called)`

`app/test/soundboard/SoundboardPanel.test.tsx` — `describe('FR-37/FR-38 panel')`:
1. `click sends sound.play with soundId`
2. `sound.played bumps badge without reordering`
3. `volume slider calls setSoundboardGain and persists to settings.volumes.v1`

`e2e/web/soundboard.spec.ts` — `describe('FR-36 soundboard e2e')` (two contexts, both in voice,
`TAVERN_SFU_MOCK=1`):
1. `A uploads beep.mp3 → appears on B via sound.updated`
2. `A plays → both clients log a soundboardPlay within 500ms of each other` (assert
   `|tA − tB| < 500` from `__tavernTestAudio` — FR-36 AC) `and playCount shows 1 on both`
3. `deafened B logs no play but badge still increments`
4. `soundboard volume persists across reload`

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/worker test` → exit 0
- [ ] `pnpm -F @tavern/worker test:ws` → exit 0 (sound.play DO WS spec)
- [ ] `pnpm -F @tavern/app test` → exit 0
- [ ] `pnpm -F @tavern/e2e exec playwright test web/soundboard.spec.ts` → all passed
- [ ] `pnpm typecheck && pnpm lint` → exit 0
- [ ] `grep -rl "FR-36\|FR-37\|FR-38" worker/test app/test e2e/web | wc -l` → ≥ 4

## STOP conditions (beyond global R1)

- `caches` (Cache API) is undefined in the Electron renderer (file:// origin, §7.6) — do NOT
  substitute a hand-rolled cache; file a blocker.
- Broadcast→play skew in e2e repeatedly exceeds 500 ms on localhost (points at a design fault, not
  a flaky test — do not raise the threshold).

## Docs (consult only these)

- https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start
- https://developer.mozilla.org/en-US/docs/Web/API/Cache
- https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData
