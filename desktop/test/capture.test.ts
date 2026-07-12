import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_SOURCE_ID } from "@tavern/shared";
import {
  getScreenSources,
  handleDisplayMediaRequest,
  openScreenRecordingSettings,
  prepareStreamAudio,
  releaseStreamAudio,
  screenAccessStatus,
  selectSource,
  setupDisplayMediaHandler,
} from "../src/main/capture";
import type { FakeSource } from "./electron-mock";
import {
  desktopCapturer,
  resetElectronMock,
  shell,
  state,
  systemPreferences,
} from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

// os.release() drives the Windows process-loopback gate (build 20348+); mutable per test.
const osRelease = vi.hoisted(() => ({ value: "10.0.26100" }));
vi.mock("node:os", () => ({ default: { release: () => osRelease.value } }));

// venmic double (Task-3): capture.ts consults it FIRST on linux; these tests pin the fallback
// layering (venmic true → no pactl; venmic false → the remap path exactly as before).
const venmicState = vi.hoisted(() => ({
  prepared: false,
  prepareCalls: 0,
  releaseCalls: 0,
}));
vi.mock("../src/main/venmic", () => ({
  prepareVenmic: vi.fn(async () => {
    venmicState.prepareCalls += 1;
    return venmicState.prepared;
  }),
  releaseVenmic: vi.fn(() => {
    venmicState.releaseCalls += 1;
  }),
}));

// pactl double: records argv per call; `respond` maps the subcommand (args[0]) to stdout, null =
// spawn/exec failure (pactl missing, pulse down).
const pactlState = vi.hoisted(() => ({
  calls: [] as string[][],
  respond: new Map<string, string | null>(),
}));
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void,
  ) => {
    pactlState.calls.push(args);
    const out = pactlState.respond.get(args[0] ?? "");
    if (out === null || out === undefined) cb(new Error("pactl failed"), "");
    else cb(null, out);
  },
}));

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

    // Armed source is consumed: a second request without re-arming is denied (callback(null) is
    // the only rejection Electron accepts without throwing — electron_browser_context.cc).
    const second = vi.fn();
    await handleDisplayMediaRequest(second);
    expect(second).toHaveBeenCalledWith(null);
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

  it("denies an unarmed display-media request without consulting the capturer", async () => {
    await selectSource(null);
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb).toHaveBeenCalledWith(null);
    // Also matters on Wayland: an unarmed request must not open a portal dialog.
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
  });

  it("denies when the armed id no longer matches any source", async () => {
    state.sources = [source("screen:1")];
    await selectSource("screen:gone");
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it("denies (never throws) when getSources itself rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    state.sources = [source("screen:1")];
    await selectSource("screen:1");
    desktopCapturer.getSources.mockRejectedValueOnce(new Error("enumeration failed"));
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it("registers a display-media handler on the session", () => {
    setupDisplayMediaHandler();
    expect(state.displayMediaHandler).not.toBeNull();
  });

  // Wayland portal mode (0.5.0 regression): every getSources opens a NEW portal session whose ids
  // invalidate the previous ones, so the handler must take the portal's pick, not re-match by id.
  describe("Wayland portal mode", () => {
    const WAYLAND = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };

    it("hands Chromium the portal-picked source regardless of the armed sentinel id", async () => {
      setPlatform("linux");
      state.sources = [source("screen:portal-99")];
      await selectSource(PORTAL_SOURCE_ID);
      const cb = vi.fn();
      await handleDisplayMediaRequest(cb, "linux", WAYLAND);
      expect(cb).toHaveBeenCalledWith({ video: state.sources[0] });
    });

    it("a cancelled/broken portal (getSources rejects) denies instead of throwing", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      setPlatform("linux");
      await selectSource(PORTAL_SOURCE_ID);
      desktopCapturer.getSources.mockRejectedValueOnce(new Error("ScreenCastPortal failed: 3"));
      const cb = vi.fn();
      await handleDisplayMediaRequest(cb, "linux", WAYLAND);
      expect(cb).toHaveBeenCalledWith(null);
    });

    it("a portal session that yields no source denies cleanly", async () => {
      setPlatform("linux");
      state.sources = [];
      await selectSource(PORTAL_SOURCE_ID);
      const cb = vi.fn();
      await handleDisplayMediaRequest(cb, "linux", WAYLAND);
      expect(cb).toHaveBeenCalledWith(null);
    });

    it("linux WITHOUT a Wayland session keeps the grid id-match", async () => {
      setPlatform("linux");
      state.sources = [source("screen:1"), source("screen:2")];
      await selectSource("screen:2");
      const cb = vi.fn();
      await handleDisplayMediaRequest(cb, "linux", {});
      expect(cb).toHaveBeenCalledWith({ video: state.sources[1] });
    });
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

describe("FR-28 Linux stream-audio remap source (pactl)", () => {
  beforeEach(() => {
    venmicState.prepared = false; // venmic declines → these tests pin the remap path
    venmicState.prepareCalls = 0;
    venmicState.releaseCalls = 0;
    pactlState.calls.length = 0;
    pactlState.respond = new Map([
      ["list", "5\tmodule-null-sink\tsink_name=x\n"],
      ["get-default-sink", "alsa_output.pci.analog-stereo\n"],
      ["load-module", "23\n"],
      ["unload-module", ""],
    ]);
  });

  it("off-linux: resolves false without touching pactl", async () => {
    expect(await prepareStreamAudio("darwin")).toBe(false);
    expect(await prepareStreamAudio("win32")).toBe(false);
    await releaseStreamAudio("darwin");
    expect(pactlState.calls).toHaveLength(0);
  });

  it("linux: remaps the DEFAULT sink's monitor under the label the renderer heuristic matches", async () => {
    expect(await prepareStreamAudio("linux")).toBe(true);
    const load = pactlState.calls.find((args) => args[0] === "load-module");
    expect(load).toEqual([
      "load-module",
      "module-remap-source",
      "master=alsa_output.pci.analog-stereo.monitor",
      "source_name=tavern_stream_audio",
      // spaceless: pipewire-pulse truncates quoted multi-word descriptions (main capture.ts note)
      "source_properties=device.description=TavernStreamMonitor",
    ]);
    // AGC-drift guard: monitor + remap pinned to 100%/unmuted right after creation.
    const volumes = pactlState.calls.filter((args) => args[0] === "set-source-volume");
    expect(volumes).toEqual([
      ["set-source-volume", "alsa_output.pci.analog-stereo.monitor", "100%"],
      ["set-source-volume", "tavern_stream_audio", "100%"],
    ]);
    const mutes = pactlState.calls.filter((args) => args[0] === "set-source-mute");
    expect(mutes).toHaveLength(2);
  });

  it("linux: unloads stale tavern_stream_audio modules before loading a fresh one", async () => {
    pactlState.respond.set(
      "list",
      "5\tmodule-null-sink\tsink_name=x\n31\tmodule-remap-source\tsource_name=tavern_stream_audio\n",
    );
    expect(await prepareStreamAudio("linux")).toBe(true);
    const unloadAt = pactlState.calls.findIndex((args) => args[0] === "unload-module");
    const loadAt = pactlState.calls.findIndex((args) => args[0] === "load-module");
    expect(pactlState.calls[unloadAt]).toEqual(["unload-module", "31"]);
    expect(unloadAt).toBeLessThan(loadAt);
  });

  it("linux: resolves false when pactl is missing or the default sink can't be read", async () => {
    pactlState.respond = new Map(); // every exec errors (no pactl at all)
    expect(await prepareStreamAudio("linux")).toBe(false);

    pactlState.respond = new Map([
      ["list", ""],
      ["get-default-sink", null],
    ]);
    expect(await prepareStreamAudio("linux")).toBe(false);
    expect(pactlState.calls.some((args) => args[0] === "load-module")).toBe(false);
  });

  it("release on linux unloads every module owning the source name", async () => {
    pactlState.respond.set(
      "list",
      "7\tmodule-remap-source\tsource_name=tavern_stream_audio\n9\tmodule-remap-source\tsource_name=tavern_stream_audio master=x\n",
    );
    await releaseStreamAudio("linux");
    const unloaded = pactlState.calls.filter((args) => args[0] === "unload-module");
    expect(unloaded).toEqual([
      ["unload-module", "7"],
      ["unload-module", "9"],
    ]);
  });

  // Task-3 layering: venmic first, remap only as the fallback.
  it("linux: a successful venmic link short-circuits — pactl is never touched", async () => {
    venmicState.prepared = true;
    expect(await prepareStreamAudio("linux")).toBe(true);
    expect(venmicState.prepareCalls).toBe(1);
    expect(pactlState.calls).toHaveLength(0);
  });

  it("linux: venmic declining falls back to the remap path (both consulted)", async () => {
    venmicState.prepared = false;
    expect(await prepareStreamAudio("linux")).toBe(true);
    expect(venmicState.prepareCalls).toBe(1);
    expect(pactlState.calls.some((args) => args[0] === "load-module")).toBe(true);
  });

  it("off-linux: venmic is never consulted", async () => {
    await prepareStreamAudio("darwin");
    expect(venmicState.prepareCalls).toBe(0);
  });

  it("release on linux releases venmic AND unloads the remap modules", async () => {
    await releaseStreamAudio("linux");
    expect(venmicState.releaseCalls).toBe(1);
    expect(pactlState.calls.some((args) => args[0] === "list")).toBe(true);
  });
});
