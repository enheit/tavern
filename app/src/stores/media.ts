import { create } from "zustand";

// Device selection + capture status skeleton; S7 fills the behavior (enumerate/switch/publish).
type CaptureState = "idle" | "active" | "error";

interface MediaState {
  devices: MediaDeviceInfo[];
  selectedMicId: string | null;
  selectedSinkId: string | null;
  captureState: CaptureState;
  setDevices: (devices: MediaDeviceInfo[]) => void;
  setSelectedMic: (id: string | null) => void;
  setSelectedSink: (id: string | null) => void;
  setCaptureState: (state: CaptureState) => void;
}

export const useMediaStore = create<MediaState>((set) => ({
  devices: [],
  selectedMicId: null,
  selectedSinkId: null,
  captureState: "idle",
  setDevices: (devices) => set({ devices }),
  setSelectedMic: (selectedMicId) => set({ selectedMicId }),
  setSelectedSink: (selectedSinkId) => set({ selectedSinkId }),
  setCaptureState: (captureState) => set({ captureState }),
}));
