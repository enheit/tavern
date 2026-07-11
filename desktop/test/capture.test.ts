import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getScreenSources,
  handleDisplayMediaRequest,
  openScreenRecordingSettings,
  screenAccessStatus,
  selectSource,
  setupDisplayMediaHandler,
} from "../src/main/capture";
import type { FakeSource } from "./electron-mock";
import { resetElectronMock, shell, state, systemPreferences } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

// os.release() drives the Windows process-loopback gate (build 20348+); mutable per test.
const osRelease = vi.hoisted(() => ({ value: "10.0.26100" }));
vi.mock("node:os", () => ({ default: { release: () => osRelease.value } }));

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function source(id: string): FakeSource {
  return {
    id,
    name: `name-${id}`,
    thumbnail: { toDataURL: () => `data:thumb-${id}` },
    appIcon: null,
  };
}

describe("FR-28 capture plumbing", () => {
  beforeEach(() => {
    resetElectronMock();
    osRelease.value = "10.0.26100";
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("maps desktopCapturer sources to the ScreenSource schema (with appIcon when present)", async () => {
    state.sources = [
      {
        id: "screen:1",
        name: "Screen 1",
        thumbnail: { toDataURL: () => "data:t1" },
        appIcon: null,
      },
      {
        id: "window:2",
        name: "Editor",
        thumbnail: { toDataURL: () => "data:t2" },
        appIcon: { toDataURL: () => "data:icon2" },
      },
    ];
    const result = await getScreenSources();
    expect(result).toEqual([
      { id: "screen:1", name: "Screen 1", thumbnailDataUrl: "data:t1" },
      { id: "window:2", name: "Editor", thumbnailDataUrl: "data:t2", appIcon: "data:icon2" },
    ]);
  });

  it("arms the selected source, resolves it once with self-audio-excluding loopback on Win11, then clears it", async () => {
    setPlatform("win32");
    osRelease.value = "10.0.26100";
    state.sources = [source("screen:1")];
    await selectSource("screen:1");

    const first = vi.fn();
    await handleDisplayMediaRequest(first);
    expect(first).toHaveBeenCalledTimes(1);
    // "loopbackWithoutChrome" = Chromium process loopback minus Tavern's own audio (no voice echo).
    expect(first.mock.calls[0]?.[0]).toEqual({
      video: state.sources[0],
      audio: "loopbackWithoutChrome",
    });

    // Armed source is consumed: a second request without re-arming is denied.
    const second = vi.fn();
    await handleDisplayMediaRequest(second);
    expect(second).toHaveBeenCalledWith({});
  });

  it("falls back to endpoint loopback on Windows builds without process loopback (<20348)", async () => {
    setPlatform("win32");
    osRelease.value = "10.0.19045";
    state.sources = [source("screen:old")];
    await selectSource("screen:old");
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb.mock.calls[0]?.[0]).toEqual({ video: state.sources[0], audio: "loopback" });
  });

  it("omits the audio key on linux (no validated loopback path yet)", async () => {
    setPlatform("linux");
    state.sources = [source("screen:9")];
    await selectSource("screen:9");
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb).toHaveBeenCalledWith({ video: state.sources[0] });
  });

  it("includes self-audio-excluding loopback on darwin", async () => {
    setPlatform("darwin");
    state.sources = [source("screen:d")];
    await selectSource("screen:d");
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb.mock.calls[0]?.[0]).toEqual({
      video: state.sources[0],
      audio: "loopbackWithoutChrome",
    });
  });

  it("denies an unarmed display-media request", async () => {
    await selectSource(null);
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb).toHaveBeenCalledWith({});
  });

  it("denies when the armed id no longer matches any source", async () => {
    state.sources = [source("screen:1")];
    await selectSource("screen:gone");
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb).toHaveBeenCalledWith({});
  });

  it("registers a display-media handler on the session", () => {
    setupDisplayMediaHandler();
    expect(state.displayMediaHandler).not.toBeNull();
  });

  it("reports the TCC screen-recording status on darwin", async () => {
    state.mediaAccessStatus = "denied";
    expect(await screenAccessStatus("darwin")).toBe("denied");
    expect(systemPreferences.getMediaAccessStatus).toHaveBeenCalledWith("screen");

    state.mediaAccessStatus = "granted";
    expect(await screenAccessStatus("darwin")).toBe("granted");
  });

  it("rejects an unexpected status value instead of forwarding it", async () => {
    state.mediaAccessStatus = "weird-new-state";
    await expect(screenAccessStatus("darwin")).rejects.toThrow();
  });

  it("always reports granted off-darwin without consulting the OS", async () => {
    state.mediaAccessStatus = "denied";
    expect(await screenAccessStatus("win32")).toBe("granted");
    expect(await screenAccessStatus("linux")).toBe("granted");
    expect(systemPreferences.getMediaAccessStatus).not.toHaveBeenCalled();
  });

  it("deep-links the Screen Recording settings pane on darwin only", async () => {
    await openScreenRecordingSettings("darwin");
    expect(shell.openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );

    shell.openExternal.mockClear();
    await openScreenRecordingSettings("win32");
    await openScreenRecordingSettings("linux");
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
