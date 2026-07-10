import { describe, expect, it, vi } from "vitest";
import { loopbackAudioSupported } from "../src/main/capture";

vi.mock("electron", () => import("./electron-mock"));

describe("FR-28 loopbackAudioSupported", () => {
  it("returns the pinned initial per-OS matrix", () => {
    expect(loopbackAudioSupported("win32")).toBe(true);
    expect(loopbackAudioSupported("darwin")).toBe(true);
    expect(loopbackAudioSupported("linux")).toBe(false);
  });
});
