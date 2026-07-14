import { beforeEach, describe, expect, it } from "vitest";
import {
  clearVoiceLevel,
  clearVoiceLevels,
  readVoiceLevel,
  setVoiceLevel,
} from "@/media/voiceLevelBus";

describe("Voice Lounge audio-level bus", () => {
  beforeEach(() => clearVoiceLevels());

  it("clamps live levels and removes silent or cleared members", () => {
    setVoiceLevel("a", 1.5);
    setVoiceLevel("b", 0.4);
    expect(readVoiceLevel("a")).toBe(1);
    expect(readVoiceLevel("b")).toBe(0.4);

    setVoiceLevel("a", 0);
    clearVoiceLevel("b");
    expect(readVoiceLevel("a")).toBe(0);
    expect(readVoiceLevel("b")).toBe(0);
  });

  it("rejects non-finite analyser output", () => {
    expect(() => setVoiceLevel("a", Number.NaN)).toThrow("voice level must be finite");
  });
});
