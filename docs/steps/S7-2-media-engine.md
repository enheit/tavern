# S7.2 — Media engine (publish/pull sessions, audio graph, capture, level meter)

- after: S0.2, S4.3 · unlocks: S7.3 · FRs: FR-19, FR-20, FR-21, FR-22, FR-23, FR-26 (engine halves), FR-27/33 (mechanics)
- references: PLAN §7.1–§7.3 (verbatim mechanics), App-B (speaking constants), App-D (presets/simulcast), §9.2 (module size), §10 (coverage ≥85% for `app/src/media`)

## Goal

Pure-TypeScript media engine in `app/src/media/` — every WebRTC/WebAudio interaction behind two
injected ports so the whole engine is unit-testable with fakes. No React, no direct browser
globals. UI steps (S7.3/S8.x/S9.x) consume ONLY these pinned APIs.

## Preconditions (run these; red = STOP)

- `grep -q "^## S0.2" docs/progress.md` → exit 0
- `grep -q "^## S4.3" docs/progress.md` → exit 0 (this step lives in `@tavern/app`, created by
  S4.2/S4.3, and consumes S4.3's `ApiClient`/`PlatformBridge`)
- `pnpm -F @tavern/shared test` → exit 0 (presets/limits are imported from shared).

## Tasks

1. Create `app/src/media/ports.ts` — the ONLY file in `app/` allowed to touch
   `RTCPeerConnection`/`AudioContext` constructors (grep-gated in DoD).
2. Create `app/src/media/sfuSignal.ts` (thin apiClient wrapper over §6.1 rtc routes).
3. Create `app/src/media/rtc/publishSession.ts` — offerer per §7.1: `addTransceiver(track,
   { direction: 'sendonly', sendEncodings })` (video gets h/l encodings from App-D; audio none)
   → `createOffer` → `setLocalDescription` → `POST tracks` (local, mids from transceivers) →
   `setRemoteDescription(answer)`. ALL SDP-mutating ops chained on one internal promise queue
   (the SFU allows no concurrent renegotiation per session; the Worker proxy is stateless — this
   queue is the single serialization point).
4. Create `app/src/media/rtc/pullSession.ts` — answerer per §7.1: pull → SFU offer
   (`requiresImmediateRenegotiation: true`) → `setRemoteDescription(offer)` → `createAnswer` →
   `setLocalDescription` → `PUT renegotiate`. Same queue discipline. Layer switch =
   `updateLayer` (tracks/update) — never a re-pull.
5. Create `app/src/media/capture.ts`: mic acquisition (echoCancellation ALWAYS true;
   `noiseSuppression`+`autoGainControl` follow the single toggle), FR-22 retoggle
   (stop → re-`getUserMedia` → `RTCRtpSender.replaceTrack` — `applyConstraints` is a Chromium
   WontFix no-op for these, crbug 327472528), screen via platform bridge (`getDisplayMedia`
   constraints use `ideal`/`max` ONLY — `min`/`exact` throw), cam fixed 720p30 (App-D).
6. Create `app/src/media/audioGraph.ts` per §7.3 exactly: 48 kHz context; muted `<audio>`
   element per remote stream (crbug 40094084 — unconditional); per-user/stream/soundboard gains
   (0..2) → deafenGain → masterGain → destination; `AudioContext.setSinkId`; pre-deafen tap for
   recording; analyser registry (local mic analyser never routed to output).
7. Create `app/src/media/levelMeter.ts` (rAF-polled RMS on an AnalyserNode; constants from
   `LIMITS`: threshold 0.02 sustained ≥100 ms, hangover 300 ms).
8. Create interface-only stubs `app/src/media/recorder.ts` and
   `app/src/media/soundboardPlayer.ts` (signatures below; bodies land in S9.3/S9.2 — export the
   types + a class that throws `new Error('S9 not implemented')` so imports typecheck).
9. Unit tests with injected fakes (below). Fakes live in `app/test/fakes/` (`FakeRtcPort`
   records constructor configs, transceivers, offers/answers; `FakeAudioPort` records the node
   graph as a serializable tree).

## Pinned interfaces & artifacts

Files created: `app/src/media/ports.ts`, `app/src/media/sfuSignal.ts`,
`app/src/media/trackName.ts`, `app/src/media/rtc/publishSession.ts`,
`app/src/media/rtc/pullSession.ts`, `app/src/media/capture.ts`, `app/src/media/audioGraph.ts`,
`app/src/media/levelMeter.ts`, `app/src/media/recorder.ts`, `app/src/media/soundboardPlayer.ts`,
`app/test/fakes/*.ts`, `app/test/media/*.test.ts`.
Modified: `app/vitest.config.ts` (add the `app/src/media/**` per-glob coverage threshold — see DoD).

```ts
// ports.ts — the ONLY constructor site
export interface RtcPort { createPeerConnection(config: RTCConfiguration): RTCPeerConnection }
export interface AudioPort {
  createContext(opts: { sampleRate: 48000 }): AudioContext;
  createAudioElement(): HTMLAudioElement; // muted flow-starter elements
}
export const browserRtcPort: RtcPort;
export const browserAudioPort: AudioPort;

// sfuSignal.ts
// RtcTracksResponse from `@tavern/shared` api.ts (S0.2); ApiClient from `app/src/lib/apiClient.ts` (S4.3).
import type { RtcTracksResponse } from '@tavern/shared';
import type { ApiClient } from '@/lib/apiClient';
export interface SfuSignal {
  newSession(serverId: string): Promise<{ sessionId: string }>;
  publishTracks(serverId: string, sessionId: string, offer: RTCSessionDescriptionInit,
    tracks: Array<{ mid: string; trackName: string }>): Promise<RtcTracksResponse>;
  pullTracks(serverId: string, sessionId: string,
    tracks: Array<{ trackName: string; preferredRid?: 'h' | 'l' }>): Promise<RtcTracksResponse>;
  renegotiate(serverId: string, sessionId: string, answer: RTCSessionDescriptionInit): Promise<void>;
  updateLayer(serverId: string, sessionId: string, mid: string, preferredRid: 'h' | 'l'): Promise<void>;
  closeTracks(serverId: string, sessionId: string, mids: string[], offer?: RTCSessionDescriptionInit): Promise<void>;
  getIceServers(): Promise<RTCIceServer[]>;
}
export function createSfuSignal(api: ApiClient): SfuSignal;

// rtc/publishSession.ts
export type PublishState = 'idle' | 'connecting' | 'connected' | 'renegotiating' | 'closed' | 'failed';
export class PublishSession {
  constructor(deps: { rtc: RtcPort; signal: SfuSignal; serverId: string; userId: string });
  readonly state: PublishState;
  readonly sessionId: string | null;
  onStateChange(cb: (s: PublishState) => void): () => void;
  connect(): Promise<void>;
  publishMic(track: MediaStreamTrack): Promise<{ trackName: string }>;               // mic:{userId}
  publishStream(video: MediaStreamTrack, audio: MediaStreamTrack | null, preset: PresetId):
    Promise<{ videoTrackName: string; audioTrackName?: string }>;                    // screen:{userId}:{n} (+screenAudio)
  publishCam(track: MediaStreamTrack): Promise<{ trackName: string }>;               // cam:{userId}
  setPreset(trackName: string, preset: PresetId): Promise<void>; // applyConstraints(ideal/max) + sender.setParameters — NEVER createOffer
  setTrackEnabled(trackName: string, enabled: boolean): void;    // mute = enabled=false; NEVER replaceTrack(null) — 30s SFU GC
  unpublish(trackNames: string[]): Promise<void>;
  close(): Promise<void>;
}

// rtc/pullSession.ts — one instance per watched stream + one 'voicePull' instance
export type PullState = PublishState;
export class PullSession {
  constructor(deps: { rtc: RtcPort; signal: SfuSignal; serverId: string });
  readonly state: PullState;
  onStateChange(cb: (s: PullState) => void): () => void;
  onTrack(cb: (trackName: string, track: MediaStreamTrack, stream: MediaStream) => void): () => void;
  connect(): Promise<void>;
  addRemoteTracks(tracks: Array<{ trackName: string; preferredRid?: 'h' | 'l' }>): Promise<void>;
  removeRemoteTracks(trackNames: string[]): Promise<void>;
  setLayer(trackName: string, rid: 'h' | 'l'): Promise<void>;
  close(): Promise<void>;
}

// capture.ts
export function getMic(opts: { deviceId?: string; noiseSuppression: boolean }): Promise<MediaStreamTrack>;
export function retoggleMic(current: MediaStreamTrack, sender: RTCRtpSender,
  opts: { deviceId?: string; noiseSuppression: boolean }): Promise<MediaStreamTrack>;
export function getScreen(platform: PlatformBridge, preset: PresetId, wantAudio: boolean):
  Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null }>;
export function getCam(deviceId?: string): Promise<MediaStreamTrack>;

// audioGraph.ts
export class AudioGraph {
  constructor(port: AudioPort);
  init(sinkId?: string): Promise<void>;
  resume(): Promise<void>;                                  // MUST be called from the join-click gesture
  attachRemoteMic(userId: string, stream: MediaStream): void;
  detachRemoteMic(userId: string): void;
  attachStreamAudio(trackName: string, stream: MediaStream): void;
  detachStreamAudio(trackName: string): void;
  attachLocalMic(track: MediaStreamTrack): void;            // analyser only — never routed to output
  setUserGain(userId: string, gain: number): void;          // 0..2
  setStreamGain(trackName: string, gain: number): void;
  setSoundboardGain(gain: number): void;
  setDeafened(deafened: boolean): void;
  setSink(deviceId: string): Promise<void>;
  playSoundboard(buffer: AudioBuffer, trimStartMs: number, trimEndMs: number): Promise<void>;
  mixForRecording(localMic: MediaStreamTrack): MediaStream; // taps pre-deafen userGains + mic
  getUserAnalyser(userId: string): AnalyserNode | null;
  getLocalAnalyser(): AnalyserNode | null;
  close(): Promise<void>;
}

// levelMeter.ts
export function watchSpeaking(analyser: AnalyserNode, cb: (speaking: boolean) => void,
  opts?: { thresholdRms?: number; sustainMs?: number; hangoverMs?: number }): () => void;

// recorder.ts (interface pinned now; implementation S9.3)
export interface RecorderChunkSink { onPart(partNumber: number, bytes: Uint8Array, isFinal: boolean): Promise<void> }
export class VoiceRecorder {
  constructor(deps: { graph: AudioGraph });
  start(localMic: MediaStreamTrack, sink: RecorderChunkSink): void;
  stop(): Promise<{ durationMs: number }>;
  readonly active: boolean;
}

// soundboardPlayer.ts (interface pinned now; implementation S9.2)
export class SoundboardPlayer {
  constructor(deps: { graph: AudioGraph; fetchSound: (soundId: string) => Promise<ArrayBuffer> });
  play(sound: { id: string; trimStartMs: number; trimEndMs: number }): Promise<void>;
}
```

Track-name grammar (`mic:{userId}` · `screen:{userId}:{n}` · `screenAudio:{userId}:{n}` ·
`cam:{userId}`, PLAN §7.1) is a local helper `app/src/media/trackName.ts` (no shared export
exists — the worker validates the same grammar independently, S7.1). The `n` counter is
per-PublishSession, monotonic, starts at 1.

## Tests

`app/test/media/publish.test.ts`
- `describe('FR-19 publish flow')`: 'connect → offer flow ordering' (fake records:
  addTransceiver(sendonly) → createOffer → setLocal → signal.publishTracks → setRemote(answer));
  'mic transceiver has no sendEncodings'; 'sequential publishes serialize on the queue (no
  interleaved createOffer)'.
- `describe('FR-27 simulcast encodings')`: exact App-D expectations for 3 presets —
  1080p30 → h `{rid:'h', maxBitrate:2_000_000, maxFramerate:30}`; 480p15 → h 400_000/15;
  1440p60 → h 4_500_000/60; l always `{rid:'l', maxBitrate:250_000, maxFramerate:15,
  scaleResolutionDownBy: <preset height/270>}`.
- `describe('FR-27 setPreset')`: 'applies applyConstraints + setParameters, createOffer NEVER
  called'; `describe('FR-26 mute')`: 'setTrackEnabled(false) never calls replaceTrack(null)'.
`app/test/media/pull.test.ts`
- `describe('FR-19 pull flow')`: 'answers the SFU offer then renegotiates (order asserted)';
  'add/remove remote tracks serialize'; `describe('FR-33 layer')`: 'setLayer → updateLayer with
  mid, no SDP op'.
`app/test/media/capture.test.ts`
- `describe('FR-22 noise toggle')`: 'retoggle = stop → getUserMedia(new constraints) →
  replaceTrack (order)'; 'echoCancellation is true in every getUserMedia call';
  `describe('FR-27 screen constraints')`: 'only ideal/max keys present in getDisplayMedia
  constraints'.
`app/test/media/audioGraph.test.ts`
- `describe('FR-20 gain routing')`: 'setUserGain(1.5) → gain node 1.5'; 'remote stream also
  attached to muted audio element'; `describe('FR-26 deafen')`: 'deafen zeroes deafenGain,
  user/stream gains untouched, mixForRecording unaffected'; 'soundboard gain independent';
  `describe('FR-21 sink')`: 'setSink calls ctx.setSinkId'.
`app/test/media/levelMeter.test.ts`
- `describe('FR-23 speaking detection')`: synthetic frames — 'RMS 0.05 for 120 ms → speaking';
  'RMS 0.05 for 60 ms → not speaking (sustain)'; 'drop below threshold → clears after 300 ms
  hangover, not before'.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- --coverage` → exit 0. Enforced by config: add an istanbul
      per-glob threshold `'app/src/media/**': { lines: 85 }` to `app/vitest.config.ts`'s
      `coverage.thresholds` (additive — leave S4.2/S4.3's existing overall/`src/lib` thresholds), so
      the exit code fails if `app/src/media` drops below 85%.
- [ ] `grep -rn "new RTCPeerConnection\|new AudioContext\|getUserMedia\|getDisplayMedia" app/src --include='*.ts' --include='*.tsx' | grep -v "src/media/ports.ts" | grep -v "src/media/capture.ts" | grep -v "src/platform/"` → empty output.
- [ ] `pnpm lint && pnpm typecheck` → exit 0.

## STOP conditions (beyond global R1)

- Any engine API here proves insufficient for an S7.3/S8.x task → STOP (interface change needs a
  blocker; dependents rely on these signatures verbatim).

## Docs (consult only these)

- https://developers.cloudflare.com/realtime/sfu/simulcast/
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/setSinkId
- https://issues.chromium.org/issues/40094084 (muted-element workaround rationale)
- https://issues.chromium.org/issues/327472528 (constraint-toggle WontFix rationale)
