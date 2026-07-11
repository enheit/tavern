// Stream presets & simulcast bitrates (PLAN App-D). Data + lookups only, no other logic.
//
// Data tiers: every base preset (resolution×fps) ships in four bitrate variants — 100% (the base
// id, unchanged wire value) and -75/-50/-35 suffixed ids at that fraction of the base cap. Tiers
// change ONLY maxKbps (geometry/fps identical): the encoder input is the knob, perceived quality is
// content-dependent and never promised. Tiered kbps clamp to ≥ LOW_LAYER.maxKbps (250) — the h layer
// must never price below the pinned low layer, so low-cap 480p variants collapse together.
export const BASE_PRESET_IDS = [
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

export type BasePresetId = (typeof BASE_PRESET_IDS)[number];

// Percent of the base preset's bitrate cap. 100 is the base id itself ("1080p30"); the others are
// suffixed ("1080p30-75"). Labeled in UI as data budget, never as quality percent.
export const DATA_TIERS = [100, 75, 50, 35] as const;

export type DataTier = (typeof DATA_TIERS)[number];

export const PRESET_IDS = [
  "480p15",
  "480p15-75",
  "480p15-50",
  "480p15-35",
  "480p30",
  "480p30-75",
  "480p30-50",
  "480p30-35",
  "480p60",
  "480p60-75",
  "480p60-50",
  "480p60-35",
  "720p15",
  "720p15-75",
  "720p15-50",
  "720p15-35",
  "720p30",
  "720p30-75",
  "720p30-50",
  "720p30-35",
  "720p60",
  "720p60-75",
  "720p60-50",
  "720p60-35",
  "1080p15",
  "1080p15-75",
  "1080p15-50",
  "1080p15-35",
  "1080p30",
  "1080p30-75",
  "1080p30-50",
  "1080p30-35",
  "1080p60",
  "1080p60-75",
  "1080p60-50",
  "1080p60-35",
  "1440p15",
  "1440p15-75",
  "1440p15-50",
  "1440p15-35",
  "1440p30",
  "1440p30-75",
  "1440p30-50",
  "1440p30-35",
  "1440p60",
  "1440p60-75",
  "1440p60-50",
  "1440p60-35",
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
  "480p15-75": { id: "480p15-75", width: 854, height: 480, fps: 15, maxKbps: 300 },
  "480p15-50": { id: "480p15-50", width: 854, height: 480, fps: 15, maxKbps: 250 },
  "480p15-35": { id: "480p15-35", width: 854, height: 480, fps: 15, maxKbps: 250 },
  "480p30": { id: "480p30", width: 854, height: 480, fps: 30, maxKbps: 600 },
  "480p30-75": { id: "480p30-75", width: 854, height: 480, fps: 30, maxKbps: 450 },
  "480p30-50": { id: "480p30-50", width: 854, height: 480, fps: 30, maxKbps: 300 },
  "480p30-35": { id: "480p30-35", width: 854, height: 480, fps: 30, maxKbps: 250 },
  "480p60": { id: "480p60", width: 854, height: 480, fps: 60, maxKbps: 900 },
  "480p60-75": { id: "480p60-75", width: 854, height: 480, fps: 60, maxKbps: 675 },
  "480p60-50": { id: "480p60-50", width: 854, height: 480, fps: 60, maxKbps: 450 },
  "480p60-35": { id: "480p60-35", width: 854, height: 480, fps: 60, maxKbps: 315 },
  "720p15": { id: "720p15", width: 1280, height: 720, fps: 15, maxKbps: 700 },
  "720p15-75": { id: "720p15-75", width: 1280, height: 720, fps: 15, maxKbps: 525 },
  "720p15-50": { id: "720p15-50", width: 1280, height: 720, fps: 15, maxKbps: 350 },
  "720p15-35": { id: "720p15-35", width: 1280, height: 720, fps: 15, maxKbps: 250 },
  "720p30": { id: "720p30", width: 1280, height: 720, fps: 30, maxKbps: 1200 },
  "720p30-75": { id: "720p30-75", width: 1280, height: 720, fps: 30, maxKbps: 900 },
  "720p30-50": { id: "720p30-50", width: 1280, height: 720, fps: 30, maxKbps: 600 },
  "720p30-35": { id: "720p30-35", width: 1280, height: 720, fps: 30, maxKbps: 420 },
  "720p60": { id: "720p60", width: 1280, height: 720, fps: 60, maxKbps: 1800 },
  "720p60-75": { id: "720p60-75", width: 1280, height: 720, fps: 60, maxKbps: 1350 },
  "720p60-50": { id: "720p60-50", width: 1280, height: 720, fps: 60, maxKbps: 900 },
  "720p60-35": { id: "720p60-35", width: 1280, height: 720, fps: 60, maxKbps: 630 },
  "1080p15": { id: "1080p15", width: 1920, height: 1080, fps: 15, maxKbps: 1200 },
  "1080p15-75": { id: "1080p15-75", width: 1920, height: 1080, fps: 15, maxKbps: 900 },
  "1080p15-50": { id: "1080p15-50", width: 1920, height: 1080, fps: 15, maxKbps: 600 },
  "1080p15-35": { id: "1080p15-35", width: 1920, height: 1080, fps: 15, maxKbps: 420 },
  "1080p30": { id: "1080p30", width: 1920, height: 1080, fps: 30, maxKbps: 2000 },
  "1080p30-75": { id: "1080p30-75", width: 1920, height: 1080, fps: 30, maxKbps: 1500 },
  "1080p30-50": { id: "1080p30-50", width: 1920, height: 1080, fps: 30, maxKbps: 1000 },
  "1080p30-35": { id: "1080p30-35", width: 1920, height: 1080, fps: 30, maxKbps: 700 },
  "1080p60": { id: "1080p60", width: 1920, height: 1080, fps: 60, maxKbps: 3000 },
  "1080p60-75": { id: "1080p60-75", width: 1920, height: 1080, fps: 60, maxKbps: 2250 },
  "1080p60-50": { id: "1080p60-50", width: 1920, height: 1080, fps: 60, maxKbps: 1500 },
  "1080p60-35": { id: "1080p60-35", width: 1920, height: 1080, fps: 60, maxKbps: 1050 },
  "1440p15": { id: "1440p15", width: 2560, height: 1440, fps: 15, maxKbps: 1800 },
  "1440p15-75": { id: "1440p15-75", width: 2560, height: 1440, fps: 15, maxKbps: 1350 },
  "1440p15-50": { id: "1440p15-50", width: 2560, height: 1440, fps: 15, maxKbps: 900 },
  "1440p15-35": { id: "1440p15-35", width: 2560, height: 1440, fps: 15, maxKbps: 630 },
  "1440p30": { id: "1440p30", width: 2560, height: 1440, fps: 30, maxKbps: 3000 },
  "1440p30-75": { id: "1440p30-75", width: 2560, height: 1440, fps: 30, maxKbps: 2250 },
  "1440p30-50": { id: "1440p30-50", width: 2560, height: 1440, fps: 30, maxKbps: 1500 },
  "1440p30-35": { id: "1440p30-35", width: 2560, height: 1440, fps: 30, maxKbps: 1050 },
  "1440p60": { id: "1440p60", width: 2560, height: 1440, fps: 60, maxKbps: 4500 },
  "1440p60-75": { id: "1440p60-75", width: 2560, height: 1440, fps: 60, maxKbps: 3375 },
  "1440p60-50": { id: "1440p60-50", width: 2560, height: 1440, fps: 60, maxKbps: 2250 },
  "1440p60-35": { id: "1440p60-35", width: 2560, height: 1440, fps: 60, maxKbps: 1575 },
};

export const DEFAULT_SCREEN_PRESET: PresetId = "1080p30";
const DEFAULT_BASE_PRESET: BasePresetId = "1080p30";
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

function isPresetId(value: string): value is PresetId {
  return PRESET_IDS.some((id) => id === value);
}

export function isBasePresetId(value: string): value is BasePresetId {
  return BASE_PRESET_IDS.some((id) => id === value);
}

// Base (100%) id of any preset: strip the tier suffix. The narrow can only fail on data-table
// corruption; the fallback keeps the signature total without an assertion.
export function basePresetOf(id: PresetId): BasePresetId {
  const base = id.split("-")[0] ?? id;
  return isBasePresetId(base) ? base : DEFAULT_BASE_PRESET;
}

export function tierOf(id: PresetId): DataTier {
  if (id.endsWith("-75")) return 75;
  if (id.endsWith("-50")) return 50;
  if (id.endsWith("-35")) return 35;
  return 100;
}

// Compose base × tier back into a table id (100 → the bare base id).
export function withTier(base: BasePresetId, tier: DataTier): PresetId {
  const id = tier === 100 ? base : `${base}-${tier}`;
  return isPresetId(id) ? id : base;
}
