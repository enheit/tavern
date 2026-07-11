import { describe, it, expect } from "vitest";
import { loopbackAudioDevice } from "../src/ipc";

describe("FR-28 loopbackAudioDevice", () => {
  it("picks process loopback (self-audio excluded) on Windows build 20348+", () => {
    expect(loopbackAudioDevice("win32", "10.0.20348")).toBe("loopbackWithoutChrome");
    expect(loopbackAudioDevice("win32", "10.0.22631")).toBe("loopbackWithoutChrome");
    expect(loopbackAudioDevice("win32", "10.0.26100")).toBe("loopbackWithoutChrome");
  });

  it("falls back to endpoint loopback (self-audio caveat stands) on older Windows", () => {
    expect(loopbackAudioDevice("win32", "10.0.19045")).toBe("loopback");
    expect(loopbackAudioDevice("win32", "10.0.17763")).toBe("loopback");
  });

  it("treats an unparsable Windows version as pre-process-loopback", () => {
    expect(loopbackAudioDevice("win32", "")).toBe("loopback");
    expect(loopbackAudioDevice("win32", "10.0")).toBe("loopback");
    expect(loopbackAudioDevice("win32", "weird")).toBe("loopback");
  });

  it("excludes self-audio on darwin (tap/SCK, any version that can loopback) and none on linux", () => {
    expect(loopbackAudioDevice("darwin", "14.5")).toBe("loopbackWithoutChrome");
    expect(loopbackAudioDevice("darwin", "")).toBe("loopbackWithoutChrome");
    expect(loopbackAudioDevice("linux", "6.9.0")).toBeNull();
  });
});
