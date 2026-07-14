import type { PublishState } from "@/media/rtc/publishSession";
import type { PullState } from "@/media/rtc/pullSession";
import type { ScreenRid } from "@tavern/shared";
import { platform } from "@/platform/types";
import { useMediaStore } from "@/stores/media";
import { useSettingsStore } from "@/stores/settings";

// The e2e test-hook surface (PLAN §10 hermeticity split / S7.4). Installed ONLY when platform.isE2E —
// production builds never expose it. Specs read these via `page.evaluate`: the PR/mock-SFU suite
// asserts signaling + local-media (deafen, per-user gains, local speaking ring, publish/pull state);
// the @realtime nightly suite reads inbound-rtp getStats. Every property is a LIVE getter so a
// `page.evaluate` reads the current value, never a stale snapshot.

export interface VoiceStats {
  bytesReceived: number;
  audioLevel: number | null;
}

export interface TavernTestAudio {
  deafened: boolean;
  userGains: Record<string, number>; // userId → effective gain 0..2 (0 when locally muted)
  speakingUserIds: string[];
  soundboardPlays: SoundboardPlayForTest[]; // filled by S9.2 (FR-36 sync AC)
  // userIds whose remote mic is attached to the live audio graph — the mock-SFU suite's pairwise
  // "can hear" truth (a graph attach requires the pull to have negotiated + the track to arrive).
  remoteMicUserIds: string[];
}

export interface SoundboardPlayForTest {
  soundId: string;
  at: number;
  mode: "shared" | "local-preview" | "editor-preview";
  trimStartMs: number;
  trimEndMs: number;
  gain: number;
}

// Outbound-rtp video summary of ONE published track (§10 @realtime, FR-27): lets the nightly
// spec separate "publisher encodes the new preset" from "the SFU delivers it to the watcher".
export interface OutboundVideoLayer {
  rid: string | null;
  frameHeight: number | null;
  framesSent: number;
  bytesSent: number;
  framesPerSecond: number | null;
  targetBitrate: number | null;
  qualityLimitationReason: string | null;
  codec: string | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  scalabilityMode: string | null;
}

export interface TavernTestRtc {
  publishState: PublishState;
  pullStates: Record<string, PullState>; // 'voice' + (S8) per-stream trackName keys
  stats(session: "voice"): Promise<VoiceStats>; // inbound-rtp audio summary
  // Per-trackName inbound audio bytes of the voice pull (mic:{uid} → bytesReceived) — the 4-client
  // @realtime pairwise regression reads this; the aggregate stats() hides a one-way-deaf pair.
  statsByTrack(session: "voice"): Promise<Record<string, number>>;
  outboundVideoStats(trackName: string): Promise<OutboundVideoLayer[]>; // publisher-side (FR-27)
  layerCalls: Array<{ trackName: string; rid: ScreenRid }>; // FR-33 setLayer switches (S8.4/S8.5)
  // Initial pull requests with each simulcast rid (null for the single-encoding screen/audio path).
  pullCalls: Array<{ trackName: string; rid: ScreenRid | null }>;
}

// The voice controller (the sole holder of the live publish/pull sessions) binds these thunks so the
// getters below always reflect the CURRENT session.
export interface TestHookSources {
  publishState(): PublishState;
  pullStates(): Record<string, PullState>;
  voiceStats(): Promise<VoiceStats>;
  voiceStatsByTrack(): Promise<Record<string, number>>;
  remoteMicUserIds(): string[];
  outboundVideoStats(trackName: string): Promise<OutboundVideoLayer[]>;
}

declare global {
  interface Window {
    __tavernTestAudio?: TavernTestAudio;
    __tavernTestRtc?: TavernTestRtc;
    // S8.5 @realtime: reads a watched stream's inbound-video getStats by trackName (0/null when the
    // stream is not currently watched). Separate global so it never collides with __tavernTestRtc.
    __tavernTestVideoStats?: (trackName: string) => Promise<VideoStats>;
  }
}

// Owned here so S9.2 can push {soundId, at} for the FR-36 cross-client sync assertion without any
// new plumbing — the array identity is stable across the object's lifetime.
const soundboardPlays: SoundboardPlayForTest[] = [];

// S8.5: per-stream watch pull states keyed by video trackName (FR-30). The dedicated per-watch
// PullSession lives inside WatchController (app/src/features/streams/useWatch.ts, one per watched
// tile) — separate from the voice pull the `sources` thunks expose — so the WatchController registers
// its live state here. `pullStates` (below) merges these with the voice pull under one Record.
const watchPullStates: Record<string, PullState> = {};

// Called by WatchController on each watch-state transition (only under platform.isE2E, so production is
// a no-op). `connected` mirrors the pull being live ('watching'); the key is deleted on unwatch/idle so
// `pullStates[trackName]` reads `undefined` again (the "cleared" assertion after a stream stops).
export function setWatchPullState(trackName: string, state: PullState): void {
  if (!platform.isE2E) return;
  watchPullStates[trackName] = state;
}

export function clearWatchPullState(trackName: string): void {
  if (!platform.isE2E) return;
  delete watchPullStates[trackName];
}

export interface VideoStats {
  framesDecoded: number;
  frameHeight: number | null;
  bytesReceived: number;
  framesPerSecond: number | null;
}

// S8.5 @realtime: per-watch inbound-video getStats reader, keyed by video trackName. The WatchController
// registers its pull's `inboundVideoStats` while watching; the nightly streams-realtime spec reads
// framesDecoded (frames flow) + frameHeight (preset drop / focus layer). Unused under the mock SFU.
const watchVideoReaders: Record<string, () => Promise<VideoStats>> = {};

export function setWatchVideoStats(trackName: string, reader: () => Promise<VideoStats>): void {
  if (!platform.isE2E) return;
  watchVideoReaders[trackName] = reader;
}

export function clearWatchVideoStats(trackName: string): void {
  if (!platform.isE2E) return;
  delete watchVideoReaders[trackName];
}

// FR-33 layer switches (S8.4 pushes, S8.5 asserts). Stable array identity across the hook's lifetime,
// like soundboardPlays — pullSession.setLayer records {trackName, rid} on each explicit layer switch.
const layerCalls: Array<{ trackName: string; rid: ScreenRid }> = [];

// Initial pull requests — pullSession.addRemoteTracks records {trackName, rid} per pulled track so the
// streams spec can assert screen video has no layer selector while webcam remains pinned high.
const pullCalls: Array<{ trackName: string; rid: ScreenRid | null }> = [];

// FR-20: the effective per-user gain the graph applies — the stored slider value, or 0 when the user
// is in VolumesV1.mutedUsers (mute is set-membership, not a gain of 0, so the slider value survives).
function effectiveUserGains(): Record<string, number> {
  const { volumes } = useSettingsStore.getState();
  const muted = new Set(volumes.mutedUsers);
  const out: Record<string, number> = {};
  for (const [userId, gain] of Object.entries(volumes.users)) {
    out[userId] = muted.has(userId) ? 0 : gain;
  }
  for (const userId of muted) if (!(userId in out)) out[userId] = 0;
  return out;
}

// Installs the hooks once, gated on platform.isE2E. Called from the voiceController singleton builder
// (the SOLE install site — the DoD grep asserts the __tavernTestAudio/__tavernTestRtc globals are
// wired nowhere else).
export function installTestHooks(sources: TestHookSources): void {
  if (!platform.isE2E) return;
  if (typeof window === "undefined") return;
  /* oxlint-disable no-underscore-dangle -- the pinned §10 e2e hook globals window.__tavernTest{Audio,Rtc} */
  if (window.__tavernTestRtc !== undefined) return;
  window.__tavernTestAudio = {
    get deafened(): boolean {
      return useMediaStore.getState().deafened;
    },
    get userGains(): Record<string, number> {
      return effectiveUserGains();
    },
    get speakingUserIds(): string[] {
      return [...useMediaStore.getState().speakingUserIds];
    },
    soundboardPlays,
    get remoteMicUserIds(): string[] {
      return sources.remoteMicUserIds();
    },
  };
  window.__tavernTestRtc = {
    get publishState(): PublishState {
      return sources.publishState();
    },
    get pullStates(): Record<string, PullState> {
      // 'voice' from the voice controller + the per-stream watch pulls (keys never collide).
      return { ...watchPullStates, ...sources.pullStates() };
    },
    stats: (_session) => sources.voiceStats(),
    statsByTrack: (_session) => sources.voiceStatsByTrack(),
    outboundVideoStats: (trackName) => sources.outboundVideoStats(trackName),
    layerCalls,
    pullCalls,
  };
  window.__tavernTestVideoStats = (trackName) =>
    watchVideoReaders[trackName]?.() ??
    Promise.resolve({
      framesDecoded: 0,
      frameHeight: null,
      bytesReceived: 0,
      framesPerSecond: null,
    });
  /* oxlint-enable no-underscore-dangle */
}
