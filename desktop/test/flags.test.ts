import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFlags, registerGpuCrashGuard } from "../src/main/flags";
import { app, appliedSwitches, emitAppEvent, resetElectronMock, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

const realPlatform = process.platform;
let dir: string;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function hasSwitch(name: string, value?: string): boolean {
  return appliedSwitches.some((s) => s.name === name && (value === undefined || s.value === value));
}

describe("flags & GPU crash guard", () => {
  beforeEach(() => {
    resetElectronMock();
    vi.unstubAllEnvs();
    dir = mkdtempSync(join(tmpdir(), "tavern-flags-"));
    state.userDataDir = dir;
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies fake-media switches in E2E mode, including the fake-audio file", () => {
    vi.stubEnv("TAVERN_E2E", "1");
    vi.stubEnv("TAVERN_FAKE_AUDIO", "/tmp/tone.wav");
    applyFlags();
    expect(hasSwitch("use-fake-device-for-media-stream")).toBe(true);
    expect(hasSwitch("use-fake-ui-for-media-stream")).toBe(true);
    expect(hasSwitch("use-file-for-fake-audio-capture", "/tmp/tone.wav")).toBe(true);
  });

  it("does not apply fake-media switches outside E2E mode", () => {
    setPlatform("darwin");
    applyFlags();
    expect(hasSwitch("use-fake-device-for-media-stream")).toBe(false);
  });

  it("redirects userData when TAVERN_USER_DATA is set", () => {
    vi.stubEnv("TAVERN_USER_DATA", "/tmp/tavern-custom");
    applyFlags();
    expect(app.setPath).toHaveBeenCalledWith("userData", "/tmp/tavern-custom");
  });

  it("adds the PulseAudio loopback feature on linux", () => {
    setPlatform("linux");
    applyFlags();
    expect(hasSwitch("enable-features", "PulseaudioLoopbackForScreenShare")).toBe(true);
  });

  it("disables the GPU when a prior crash flag file exists", () => {
    writeFileSync(join(dir, "gpu-crash"), "1");
    applyFlags();
    expect(hasSwitch("disable-gpu")).toBe(true);
  });

  it("does not disable the GPU without a crash flag", () => {
    setPlatform("darwin");
    applyFlags();
    expect(hasSwitch("disable-gpu")).toBe(false);
  });

  it("relaunches with a persisted flag after two GPU crashes within the window", () => {
    registerGpuCrashGuard();
    emitAppEvent("child-process-gone", {}, { type: "GPU" });
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "gpu-crash"))).toBe(false);

    emitAppEvent("child-process-gone", {}, { type: "GPU" });
    expect(existsSync(join(dir, "gpu-crash"))).toBe(true);
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  it("ignores non-GPU child-process crashes", () => {
    registerGpuCrashGuard();
    emitAppEvent("child-process-gone", {}, { type: "Utility" });
    emitAppEvent("child-process-gone", {}, { type: "Utility" });
    expect(app.relaunch).not.toHaveBeenCalled();
  });
});
