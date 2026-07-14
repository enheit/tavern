import { describe, it, expect } from "vitest";
import {
  PRESET_IDS,
  BASE_PRESET_IDS,
  DATA_TIERS,
  presetKbps,
  kbpsFor,
  lowLayerScaleDown,
  DEFAULT_SCREEN_PRESET,
  basePresetOf,
  tierOf,
  withTier,
  screenLayerSpecs,
  contentHintForPreset,
  degradationPreferenceForPreset,
  presetFitsCaptureCeiling,
} from "../src/presets";

describe("App-D presets", () => {
  it("has 12 base ids × 4 data tiers with correct h-layer bitrates", () => {
    expect(BASE_PRESET_IDS.length).toBe(12);
    expect(PRESET_IDS.length).toBe(BASE_PRESET_IDS.length * DATA_TIERS.length);
    expect(presetKbps("1080p60")).toBe(12000);
    expect(presetKbps("480p15")).toBe(400);
    expect(kbpsFor("1080p30", "h")).toBe(3500);
    expect(kbpsFor("1080p30", "i")).toBe(1225);
    expect(kbpsFor("1080p30", "l")).toBe(350);
    expect(DEFAULT_SCREEN_PRESET).toBe("1080p30");
  });

  it("tiered ids scale the base cap and clamp to the low layer", () => {
    expect(presetKbps("1080p30-75")).toBe(2625);
    expect(presetKbps("1080p30-50")).toBe(1750);
    expect(presetKbps("1080p30-35")).toBe(1225);
    expect(presetKbps("480p15-50")).toBe(250);
    expect(presetKbps("480p15-35")).toBe(250);
    for (const id of PRESET_IDS) {
      expect(presetKbps(id)).toBeGreaterThanOrEqual(250);
    }
  });

  it("basePresetOf/tierOf/withTier round-trip every id", () => {
    for (const id of PRESET_IDS) {
      expect(withTier(basePresetOf(id), tierOf(id))).toBe(id);
    }
    expect(basePresetOf("1440p60-35")).toBe("1440p60");
    expect(tierOf("1080p30")).toBe(100);
    expect(withTier("720p30", 100)).toBe("720p30");
  });

  it("derives bounded h/i/l layers from the selected tier", () => {
    expect(screenLayerSpecs("1080p30")).toEqual([
      { rid: "h", heightTarget: 1080, fps: 30, maxKbps: 3500 },
      { rid: "i", heightTarget: 540, fps: 30, maxKbps: 1225 },
      { rid: "l", heightTarget: 270, fps: 30, maxKbps: 350 },
    ]);
    expect(screenLayerSpecs("480p15")).toEqual([
      { rid: "h", heightTarget: 480, fps: 15, maxKbps: 400 },
      { rid: "i", heightTarget: 240, fps: 15, maxKbps: 150 },
      { rid: "l", heightTarget: 180, fps: 15, maxKbps: 100 },
    ]);
    expect(lowLayerScaleDown("1080p30")).toBe(4);
    expect(lowLayerScaleDown("1440p60")).toBe(4);
    for (const id of PRESET_IDS) {
      expect(lowLayerScaleDown(id)).toBeGreaterThanOrEqual(1);
    }
  });

  it("maps cadence to content while preserving explicit screen geometry", () => {
    expect(contentHintForPreset("1080p60")).toBe("motion");
    expect(degradationPreferenceForPreset("1080p60")).toBe("maintain-resolution");
    expect(contentHintForPreset("1080p15")).toBe("detail");
    expect(degradationPreferenceForPreset("1080p15")).toBe("maintain-resolution");
    expect(degradationPreferenceForPreset("1080p30")).toBe("maintain-resolution");
    expect(presetFitsCaptureCeiling("720p60", "1080p60")).toBe(true);
    expect(presetFitsCaptureCeiling("1080p60", "1080p30")).toBe(false);
    expect(presetFitsCaptureCeiling("1440p30", "1080p60")).toBe(false);
  });
});
