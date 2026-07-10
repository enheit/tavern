import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getScreenSources,
  handleDisplayMediaRequest,
  selectSource,
  setupDisplayMediaHandler,
} from "../src/main/capture";
import type { FakeSource } from "./electron-mock";
import { resetElectronMock, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

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

  it("arms the selected source, resolves it once with loopback audio, then clears it", async () => {
    setPlatform("win32");
    state.sources = [source("screen:1")];
    await selectSource("screen:1");

    const first = vi.fn();
    await handleDisplayMediaRequest(first);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]?.[0]).toEqual({ video: state.sources[0], audio: "loopback" });

    // Armed source is consumed: a second request without re-arming is denied.
    const second = vi.fn();
    await handleDisplayMediaRequest(second);
    expect(second).toHaveBeenCalledWith({});
  });

  it("omits the audio key on linux (no validated loopback path yet)", async () => {
    setPlatform("linux");
    state.sources = [source("screen:9")];
    await selectSource("screen:9");
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb).toHaveBeenCalledWith({ video: state.sources[0] });
  });

  it("includes loopback audio on darwin", async () => {
    setPlatform("darwin");
    state.sources = [source("screen:d")];
    await selectSource("screen:d");
    const cb = vi.fn();
    await handleDisplayMediaRequest(cb);
    expect(cb.mock.calls[0]?.[0]).toEqual({ video: state.sources[0], audio: "loopback" });
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
});
