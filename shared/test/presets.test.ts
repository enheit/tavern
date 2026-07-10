import { describe, it, expect } from "vitest";
import {
  PRESET_IDS,
  presetKbps,
  kbpsFor,
  lowLayerScaleDown,
  DEFAULT_SCREEN_PRESET,
} from "../src/presets";

describe("App-D presets", () => {
  it("has 12 ids with correct h-layer bitrates", () => {
    expect(PRESET_IDS.length).toBe(12);
    expect(presetKbps("1080p60")).toBe(3000);
    expect(presetKbps("480p15")).toBe(400);
    expect(kbpsFor("1080p30", "h")).toBe(2000);
    expect(kbpsFor("1080p30", "l")).toBe(250);
    expect(DEFAULT_SCREEN_PRESET).toBe("1080p30");
  });

  it("lowLayerScaleDown maps height to the 270px low layer", () => {
    expect(lowLayerScaleDown("1080p30")).toBe(4);
    expect(lowLayerScaleDown("1440p60")).toBe(1440 / 270);
    for (const id of PRESET_IDS) {
      expect(lowLayerScaleDown(id)).toBeGreaterThanOrEqual(1);
    }
  });
});
