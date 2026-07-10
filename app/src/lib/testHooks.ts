import type { PublishState } from "@/media/rtc/publishSession";
import type { PullState } from "@/media/rtc/pullSession";
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
  soundboardPlays: Array<{ soundId: string; at: number }>; // filled by S9.2 (FR-36 sync AC)
}

export interface TavernTestRtc {
  publishState: PublishState;
  pullStates: Record<string, PullState>; // 'voice' + (S8) per-stream trackName keys
  stats(session: "voice"): Promise<VoiceStats>; // inbound-rtp audio summary
  layerCalls: Array<{ trackName: string; rid: "h" | "l" }>; // FR-33 setLayer switches (S8.4/S8.5)
}

// The voice controller (the sole holder of the live publish/pull sessions) binds these thunks so the
// getters below always reflect the CURRENT session.
export interface TestHookSources {
  publishState(): PublishState;
  pullStates(): Record<string, PullState>;
  voiceStats(): Promise<VoiceStats>;
}

declare global {
  interface Window {
    __tavernTestAudio?: TavernTestAudio;
    __tavernTestRtc?: TavernTestRtc;
  }
}

// Owned here so S9.2 can push {soundId, at} for the FR-36 cross-client sync assertion without any
// new plumbing — the array identity is stable across the object's lifetime.
const soundboardPlays: Array<{ soundId: string; at: number }> = [];

// FR-33 layer switches (S8.4 pushes, S8.5 asserts). Stable array identity across the hook's lifetime,
// like soundboardPlays — pullSession.setLayer records {trackName, rid} on each grid↔focus switch.
const layerCalls: Array<{ trackName: string; rid: "h" | "l" }> = [];

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
  };
  window.__tavernTestRtc = {
    get publishState(): PublishState {
      return sources.publishState();
    },
    get pullStates(): Record<string, PullState> {
      return sources.pullStates();
    },
    stats: (_session) => sources.voiceStats(),
    layerCalls,
  };
  /* oxlint-enable no-underscore-dangle */
}
