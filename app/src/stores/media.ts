import type { PresetId } from "@tavern/shared";
import { create } from "zustand";
import { type DeviceSettingsV1, loadDeviceSettings } from "@/stores/settings";

// Device selection + capture status (S4.3 skeleton) plus the S7.3 voice-session state the
// voiceController writes to. `captureState` is untouched (S8.1 owns it); `selectedMicId`/
// `selectedSinkId` are subsumed by `deviceSelection` (§S7.3 naming note) but kept so nothing that
// still reads them breaks.
type CaptureState = "idle" | "active" | "error";

// The join lifecycle status (single-voice: one at a time across all servers).
export type VoiceStatus = "idle" | "joining" | "joined" | "leaving" | "error";

interface MediaState {
  devices: MediaDeviceInfo[];
  selectedMicId: string | null;
  selectedSinkId: string | null;
  captureState: CaptureState;
  // FR-18 voice session (written by the voiceController).
  voiceStatus: VoiceStatus;
  inVoiceServerId: string | null;
  // FR-26 self flags.
  muted: boolean;
  deafened: boolean;
  // FR-23 speaking ring — the set of userIds currently over the speaking threshold (self + remotes).
  speakingUserIds: ReadonlySet<string>;
  // FR-27 self screen-share state (mirrored from the ScreenShareController) — the ControlsBar reads
  // it for the idle↔sharing button; `sharePreset`/`shareTrackName` are the active share's identity.
  sharing: boolean;
  sharePreset: PresetId | null;
  shareTrackName: string | null;
  // FR-21/22 selected device prefs (runtime mirror of the persisted settings row).
  deviceSelection: DeviceSettingsV1;
  setDevices: (devices: MediaDeviceInfo[]) => void;
  setSelectedMic: (id: string | null) => void;
  setSelectedSink: (id: string | null) => void;
  setCaptureState: (state: CaptureState) => void;
  setVoiceStatus: (status: VoiceStatus) => void;
  setInVoiceServerId: (serverId: string | null) => void;
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
  setSpeaking: (userId: string, speaking: boolean) => void;
  clearSpeaking: () => void;
  setDeviceSelection: (deviceSelection: DeviceSettingsV1) => void;
  setShareState: (share: {
    sharing: boolean;
    sharePreset: PresetId | null;
    shareTrackName: string | null;
  }) => void;
}

export const useMediaStore = create<MediaState>((set) => ({
  devices: [],
  selectedMicId: null,
  selectedSinkId: null,
  captureState: "idle",
  voiceStatus: "idle",
  inVoiceServerId: null,
  muted: false,
  deafened: false,
  speakingUserIds: new Set<string>(),
  sharing: false,
  sharePreset: null,
  shareTrackName: null,
  deviceSelection: loadDeviceSettings(),
  setDevices: (devices) => set({ devices }),
  setSelectedMic: (selectedMicId) => set({ selectedMicId }),
  setSelectedSink: (selectedSinkId) => set({ selectedSinkId }),
  setCaptureState: (captureState) => set({ captureState }),
  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),
  setInVoiceServerId: (inVoiceServerId) => set({ inVoiceServerId }),
  setMuted: (muted) => set({ muted }),
  setDeafened: (deafened) => set({ deafened }),
  setSpeaking: (userId, speaking) =>
    set((state) => {
      const has = state.speakingUserIds.has(userId);
      if (has === speaking) return {};
      const next = new Set(state.speakingUserIds);
      if (speaking) next.add(userId);
      else next.delete(userId);
      return { speakingUserIds: next };
    }),
  clearSpeaking: () => set({ speakingUserIds: new Set<string>() }),
  setDeviceSelection: (deviceSelection) => set({ deviceSelection }),
  setShareState: ({ sharing, sharePreset, shareTrackName }) =>
    set({ sharing, sharePreset, shareTrackName }),
}));
