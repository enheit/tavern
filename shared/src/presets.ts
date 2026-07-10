// Stream presets & simulcast bitrates (PLAN App-D). Data + lookups only, no other logic.
export const PRESET_IDS = [
  "480p15",
  "480p30",
  "480p60",
  "720p15",
  "720p30",
  "720p60",
  "1080p15",
  "1080p30",
  "1080p60",
  "1440p15",
  "1440p30",
  "1440p60",
] as const;

export type PresetId = (typeof PRESET_IDS)[number];

export interface Preset {
  id: PresetId;
  width: number;
  height: number;
  fps: number;
  maxKbps: number;
}

export const SCREEN_PRESETS: Record<PresetId, Preset> = {
  "480p15": { id: "480p15", width: 854, height: 480, fps: 15, maxKbps: 400 },
  "480p30": { id: "480p30", width: 854, height: 480, fps: 30, maxKbps: 600 },
  "480p60": { id: "480p60", width: 854, height: 480, fps: 60, maxKbps: 900 },
  "720p15": { id: "720p15", width: 1280, height: 720, fps: 15, maxKbps: 700 },
  "720p30": { id: "720p30", width: 1280, height: 720, fps: 30, maxKbps: 1200 },
  "720p60": { id: "720p60", width: 1280, height: 720, fps: 60, maxKbps: 1800 },
  "1080p15": { id: "1080p15", width: 1920, height: 1080, fps: 15, maxKbps: 1200 },
  "1080p30": { id: "1080p30", width: 1920, height: 1080, fps: 30, maxKbps: 2000 },
  "1080p60": { id: "1080p60", width: 1920, height: 1080, fps: 60, maxKbps: 3000 },
  "1440p15": { id: "1440p15", width: 2560, height: 1440, fps: 15, maxKbps: 1800 },
  "1440p30": { id: "1440p30", width: 2560, height: 1440, fps: 30, maxKbps: 3000 },
  "1440p60": { id: "1440p60", width: 2560, height: 1440, fps: 60, maxKbps: 4500 },
};

export const DEFAULT_SCREEN_PRESET: PresetId = "1080p30";
export const LOW_LAYER = { heightTarget: 270, fps: 15, maxKbps: 250 } as const;
export const WEBCAM_PRESET = { width: 1280, height: 720, fps: 30, maxKbps: 1000 } as const;
export const WEBCAM_LOW = { heightTarget: 180, fps: 15, maxKbps: 150 } as const;

export function presetKbps(id: PresetId): number {
  return SCREEN_PRESETS[id].maxKbps;
}

// 'h' → the selected preset's h-layer bitrate; 'l' → the pinned low-layer bitrate (250).
export function kbpsFor(preset: PresetId, rid: "h" | "l"): number {
  return rid === "h" ? presetKbps(preset) : LOW_LAYER.maxKbps;
}

export function lowLayerScaleDown(id: PresetId): number {
  return SCREEN_PRESETS[id].height / LOW_LAYER.heightTarget;
}
