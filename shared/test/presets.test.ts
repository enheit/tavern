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
  LOW_LAYER,
} from "../src/presets";

describe("App-D presets", () => {
  it("has 12 base ids × 4 data tiers with correct h-layer bitrates", () => {
    expect(BASE_PRESET_IDS.length).toBe(12);
    expect(PRESET_IDS.length).toBe(BASE_PRESET_IDS.length * DATA_TIERS.length);
    expect(presetKbps("1080p60")).toBe(6000);
    expect(presetKbps("480p15")).toBe(400);
    expect(kbpsFor("1080p30", "h")).toBe(3500);
    expect(kbpsFor("1080p30", "l")).toBe(250);
    expect(DEFAULT_SCREEN_PRESET).toBe("1080p30");
  });

  it("tiered ids scale the base cap and clamp to the low layer", () => {
    expect(presetKbps("1080p30-75")).toBe(2625);
    expect(presetKbps("1080p30-50")).toBe(1750);
    expect(presetKbps("1080p30-35")).toBe(1225);
    // low-cap variants clamp to the pinned low layer (250)
    expect(presetKbps("480p15-50")).toBe(LOW_LAYER.maxKbps);
    expect(presetKbps("480p15-35")).toBe(LOW_LAYER.maxKbps);
    for (const id of PRESET_IDS) {
      expect(presetKbps(id)).toBeGreaterThanOrEqual(LOW_LAYER.maxKbps);
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

  it("lowLayerScaleDown maps height to the 270px low layer", () => {
    expect(lowLayerScaleDown("1080p30")).toBe(4);
    expect(lowLayerScaleDown("1440p60")).toBe(1440 / 270);
    for (const id of PRESET_IDS) {
      expect(lowLayerScaleDown(id)).toBeGreaterThanOrEqual(1);
    }
  });
});
