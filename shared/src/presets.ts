// Stream presets & simulcast bitrates (PLAN App-D). Data + lookups only, no other logic.
//
// Data tiers: every base preset (resolution×fps) ships in four bitrate variants — 100% (the base
// id, unchanged wire value) and -75/-50/-35 suffixed ids at that fraction of the base cap. Tiers
// change ONLY maxKbps (geometry/fps identical): the encoder input is the knob, perceived quality is
// content-dependent and never promised. Tiered high-layer caps retain the historical 250 kbps floor;
// the intermediate/low simulcast caps are derived from that selected cap by screenLayerSpecs().
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

export const SCREEN_RIDS = ["h", "i", "l"] as const;
export type ScreenRid = (typeof SCREEN_RIDS)[number];
export const SCREEN_SIMULCAST_PROFILE = "h_i_l_v2" as const;
export type ScreenSimulcastProfile = typeof SCREEN_SIMULCAST_PROFILE;

export type StreamContentMode = "detail" | "balanced" | "motion";
export type VideoContentHint = "detail" | "motion";
export type VideoDegradationPreference = "maintain-resolution" | "balanced" | "maintain-framerate";

export interface ScreenLayerSpec {
  rid: ScreenRid;
  heightTarget: number;
  fps: number;
  maxKbps: number;
}

// Base caps re-anchored 2026-07-11 (quality-probe finding): the old 30/60fps caps (e.g. 1080p60 =
// 3000) starved dynamic content — streams are usually motion (video/games), and a realtime encoder
// at ~0.02 bits/pixel turns motion into unreadable blur. New anchors follow the industry envelope
// for realtime screen motion (≈0.05 bpp at 30fps, ×~1.6 for 60fps — Discord streams 1080p60 at
// ~6–8 Mbps). 15fps rows are unchanged (mostly-static document sharing). Data tiers give the
// cost-conscious knob back; the meter reprices automatically via kbpsFor.
export const SCREEN_PRESETS: Record<PresetId, Preset> = {
  "480p15": { id: "480p15", width: 854, height: 480, fps: 15, maxKbps: 400 },
  "480p15-75": { id: "480p15-75", width: 854, height: 480, fps: 15, maxKbps: 300 },
  "480p15-50": { id: "480p15-50", width: 854, height: 480, fps: 15, maxKbps: 250 },
  "480p15-35": { id: "480p15-35", width: 854, height: 480, fps: 15, maxKbps: 250 },
  "480p30": { id: "480p30", width: 854, height: 480, fps: 30, maxKbps: 800 },
  "480p30-75": { id: "480p30-75", width: 854, height: 480, fps: 30, maxKbps: 600 },
  "480p30-50": { id: "480p30-50", width: 854, height: 480, fps: 30, maxKbps: 400 },
  "480p30-35": { id: "480p30-35", width: 854, height: 480, fps: 30, maxKbps: 280 },
  "480p60": { id: "480p60", width: 854, height: 480, fps: 60, maxKbps: 1200 },
  "480p60-75": { id: "480p60-75", width: 854, height: 480, fps: 60, maxKbps: 900 },
  "480p60-50": { id: "480p60-50", width: 854, height: 480, fps: 60, maxKbps: 600 },
  "480p60-35": { id: "480p60-35", width: 854, height: 480, fps: 60, maxKbps: 420 },
  "720p15": { id: "720p15", width: 1280, height: 720, fps: 15, maxKbps: 700 },
  "720p15-75": { id: "720p15-75", width: 1280, height: 720, fps: 15, maxKbps: 525 },
  "720p15-50": { id: "720p15-50", width: 1280, height: 720, fps: 15, maxKbps: 350 },
  "720p15-35": { id: "720p15-35", width: 1280, height: 720, fps: 15, maxKbps: 250 },
  "720p30": { id: "720p30", width: 1280, height: 720, fps: 30, maxKbps: 1800 },
  "720p30-75": { id: "720p30-75", width: 1280, height: 720, fps: 30, maxKbps: 1350 },
  "720p30-50": { id: "720p30-50", width: 1280, height: 720, fps: 30, maxKbps: 900 },
  "720p30-35": { id: "720p30-35", width: 1280, height: 720, fps: 30, maxKbps: 630 },
  "720p60": { id: "720p60", width: 1280, height: 720, fps: 60, maxKbps: 3000 },
  "720p60-75": { id: "720p60-75", width: 1280, height: 720, fps: 60, maxKbps: 2250 },
  "720p60-50": { id: "720p60-50", width: 1280, height: 720, fps: 60, maxKbps: 1500 },
  "720p60-35": { id: "720p60-35", width: 1280, height: 720, fps: 60, maxKbps: 1050 },
  "1080p15": { id: "1080p15", width: 1920, height: 1080, fps: 15, maxKbps: 1200 },
  "1080p15-75": { id: "1080p15-75", width: 1920, height: 1080, fps: 15, maxKbps: 900 },
  "1080p15-50": { id: "1080p15-50", width: 1920, height: 1080, fps: 15, maxKbps: 600 },
  "1080p15-35": { id: "1080p15-35", width: 1920, height: 1080, fps: 15, maxKbps: 420 },
  "1080p30": { id: "1080p30", width: 1920, height: 1080, fps: 30, maxKbps: 3500 },
  "1080p30-75": { id: "1080p30-75", width: 1920, height: 1080, fps: 30, maxKbps: 2625 },
  "1080p30-50": { id: "1080p30-50", width: 1920, height: 1080, fps: 30, maxKbps: 1750 },
  "1080p30-35": { id: "1080p30-35", width: 1920, height: 1080, fps: 30, maxKbps: 1225 },
  "1080p60": { id: "1080p60", width: 1920, height: 1080, fps: 60, maxKbps: 6000 },
  "1080p60-75": { id: "1080p60-75", width: 1920, height: 1080, fps: 60, maxKbps: 4500 },
  "1080p60-50": { id: "1080p60-50", width: 1920, height: 1080, fps: 60, maxKbps: 3000 },
  "1080p60-35": { id: "1080p60-35", width: 1920, height: 1080, fps: 60, maxKbps: 2100 },
  "1440p15": { id: "1440p15", width: 2560, height: 1440, fps: 15, maxKbps: 1800 },
  "1440p15-75": { id: "1440p15-75", width: 2560, height: 1440, fps: 15, maxKbps: 1350 },
  "1440p15-50": { id: "1440p15-50", width: 2560, height: 1440, fps: 15, maxKbps: 900 },
  "1440p15-35": { id: "1440p15-35", width: 2560, height: 1440, fps: 15, maxKbps: 630 },
  "1440p30": { id: "1440p30", width: 2560, height: 1440, fps: 30, maxKbps: 5000 },
  "1440p30-75": { id: "1440p30-75", width: 2560, height: 1440, fps: 30, maxKbps: 3750 },
  "1440p30-50": { id: "1440p30-50", width: 2560, height: 1440, fps: 30, maxKbps: 2500 },
  "1440p30-35": { id: "1440p30-35", width: 2560, height: 1440, fps: 30, maxKbps: 1750 },
  "1440p60": { id: "1440p60", width: 2560, height: 1440, fps: 60, maxKbps: 9000 },
  "1440p60-75": { id: "1440p60-75", width: 2560, height: 1440, fps: 60, maxKbps: 6750 },
  "1440p60-50": { id: "1440p60-50", width: 2560, height: 1440, fps: 60, maxKbps: 4500 },
  "1440p60-35": { id: "1440p60-35", width: 2560, height: 1440, fps: 60, maxKbps: 3150 },
};

export const DEFAULT_SCREEN_PRESET: PresetId = "1080p30";
const DEFAULT_BASE_PRESET: BasePresetId = "1080p30";
export const WEBCAM_PRESET = { width: 1280, height: 720, fps: 30, maxKbps: 1000 } as const;
export const WEBCAM_INTERMEDIATE = { heightTarget: 360, fps: 30, maxKbps: 350 } as const;
export const WEBCAM_LOW = { heightTarget: 180, fps: 15, maxKbps: 150 } as const;

export function presetKbps(id: PresetId): number {
  return SCREEN_PRESETS[id].maxKbps;
}

// Three bounded screen encodings. The middle layer preserves the selected cadence at half-height;
// the low layer preserves reachability at quarter-height and never exceeds 30 fps. Bitrate ratios are
// deliberately computed from the selected data tier so the transport and egress meter stay aligned.
export function screenLayerSpecs(preset: PresetId): readonly ScreenLayerSpec[] {
  const selected = SCREEN_PRESETS[preset];
  const highKbps = selected.maxKbps;
  const intermediateKbps = Math.min(
    Math.round(highKbps * 0.6),
    Math.max(150, Math.round(highKbps * 0.35)),
  );
  const lowKbps = Math.min(
    Math.round((intermediateKbps * 2) / 3),
    Math.max(100, Math.round(highKbps * 0.1)),
  );
  return [
    { rid: "h", heightTarget: selected.height, fps: selected.fps, maxKbps: highKbps },
    {
      rid: "i",
      heightTarget: Math.max(240, Math.round(selected.height / 2)),
      fps: selected.fps,
      maxKbps: intermediateKbps,
    },
    {
      rid: "l",
      heightTarget: Math.max(180, Math.round(selected.height / 4)),
      fps: Math.min(selected.fps, 30),
      maxKbps: lowKbps,
    },
  ];
}

export function screenLayerSpec(preset: PresetId, rid: ScreenRid): ScreenLayerSpec {
  const layers = screenLayerSpecs(preset);
  const found = layers.find((layer) => layer.rid === rid);
  if (found !== undefined) return found;
  const high = layers[0];
  if (high === undefined) throw new Error(`preset ${preset} has no simulcast layers`);
  return high;
}

export function kbpsFor(preset: PresetId, rid: ScreenRid): number {
  return screenLayerSpec(preset, rid).maxKbps;
}

export function lowLayerScaleDown(id: PresetId): number {
  const spec = screenLayerSpec(id, "l");
  return SCREEN_PRESETS[id].height / spec.heightTarget;
}

export function contentModeForPreset(preset: PresetId): StreamContentMode {
  const fps = SCREEN_PRESETS[preset].fps;
  if (fps >= 60) return "motion";
  if (fps <= 15) return "detail";
  return "balanced";
}

export function contentHintForPreset(preset: PresetId): VideoContentHint {
  return contentModeForPreset(preset) === "detail" ? "detail" : "motion";
}

export function degradationPreferenceForPreset(preset: PresetId): VideoDegradationPreference {
  const mode = contentModeForPreset(preset);
  if (mode === "motion") return "maintain-framerate";
  if (mode === "detail") return "maintain-resolution";
  return "balanced";
}

// Encoder-only switches are truthful only while the requested geometry/cadence is inside the
// acquisition ceiling. Crossing either boundary requires a fresh display-capture selection.
export function presetFitsCaptureCeiling(preset: PresetId, ceiling: PresetId): boolean {
  const requested = SCREEN_PRESETS[preset];
  const captured = SCREEN_PRESETS[ceiling];
  return (
    requested.width <= captured.width &&
    requested.height <= captured.height &&
    requested.fps <= captured.fps
  );
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
