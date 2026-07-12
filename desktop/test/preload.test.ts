import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureSourceMode, loopbackAudioDevice } from "@tavern/shared";
import type { TavernIpc } from "@tavern/shared";
import { bridgeInstalled } from "../src/preload/index";
import {
  emitRendererEvent,
  exposedInMainWorld,
  ipcRenderer,
  resetElectronMock,
  state,
} from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

// The preload runs its contextBridge.exposeInMainWorld once on import; capture that surface.
const api = exposedInMainWorld.get("tavern") as TavernIpc;

describe("IPC preload bridge (window.tavern)", () => {
  beforeEach(() => {
    resetElectronMock();
  });

  it("exposes only the wrapped typed surface — never raw ipcRenderer (checklist #20)", () => {
    // `api` was captured at import time (before beforeEach cleared the registry).
    expect(bridgeInstalled).toBe(true);
    expect(api).toBeDefined();
    expect(Object.keys(api).toSorted()).toEqual(
      [
        "capture",
        "captureSourceMode",
        "isE2E",
        "loopbackSelfAudioExcluded",
        "notifications",
        "platform",
        "secrets",
        "shell",
        "updates",
      ].toSorted(),
    );
    expect("ipcRenderer" in api).toBe(false);
    expect("on" in api).toBe(false);
    expect("invoke" in api).toBe(false);
  });

  it("reports a valid platform parsed from process.platform", () => {
    expect(["win32", "darwin", "linux"]).toContain(api.platform);
  });

  it("loopbackSelfAudioExcluded mirrors loopbackAudioDevice for this host", () => {
    // Plain Node has no process.getSystemVersion → the preload's optional chain yields "", the
    // same input the expectation uses, so this is deterministic per host OS (true on darwin,
    // false on win32/linux unit-test hosts).
    expect(api.loopbackSelfAudioExcluded).toBe(
      loopbackAudioDevice(process.platform, "") === "loopbackWithoutChrome",
    );
  });

  it("captureSourceMode mirrors captureSourceMode() for this host env", () => {
    // Deterministic per host: "portal" only on a real linux Wayland session; unit-test hosts
    // (darwin dev, headless linux CI) read "grid".
    expect(api.captureSourceMode).toBe(captureSourceMode(process.platform, process.env));
  });

  it("secrets.getToken invokes the channel and parses string|null", async () => {
    state.invokeResults.set("secrets:getToken", "tok-1");
    expect(await api.secrets.getToken()).toBe("tok-1");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("secrets:getToken");

    state.invokeResults.set("secrets:getToken", null);
    expect(await api.secrets.getToken()).toBeNull();
  });

  it("secrets.setToken forwards the token argument", async () => {
    await api.secrets.setToken("abc");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("secrets:setToken", "abc");
  });

  it("capture.getScreenSources parses the ScreenSource array, rejecting bad shapes", async () => {
    state.invokeResults.set("capture:getScreenSources", [
      { id: "s1", name: "Screen", thumbnailDataUrl: "data:x" },
    ]);
    expect(await api.capture.getScreenSources()).toEqual([
      { id: "s1", name: "Screen", thumbnailDataUrl: "data:x" },
    ]);

    state.invokeResults.set("capture:getScreenSources", [{ id: "s1" }]);
    await expect(api.capture.getScreenSources()).rejects.toThrow();
  });

  it("capture.prepareStreamAudio parses a boolean; releaseStreamAudio invokes its channel", async () => {
    state.invokeResults.set("capture:prepareStreamAudio", true);
    expect(await api.capture.prepareStreamAudio()).toBe(true);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:prepareStreamAudio");
    await api.capture.releaseStreamAudio();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:releaseStreamAudio");
  });

  it("capture.selectSource + loopbackAudioSupported round-trip", async () => {
    await api.capture.selectSource("screen:1");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:selectSource", "screen:1");

    state.invokeResults.set("capture:loopbackAudioSupported", true);
    expect(await api.capture.loopbackAudioSupported()).toBe(true);
  });

  it("capture.screenAccessStatus parses the status enum, rejecting junk", async () => {
    state.invokeResults.set("capture:screenAccessStatus", "denied");
    expect(await api.capture.screenAccessStatus()).toBe("denied");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:screenAccessStatus");

    state.invokeResults.set("capture:screenAccessStatus", "nope");
    await expect(api.capture.screenAccessStatus()).rejects.toThrow();
  });

  it("capture.openScreenRecordingSettings invokes its channel", async () => {
    await api.capture.openScreenRecordingSettings();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:openScreenRecordingSettings");
  });

  it("notifications.show forwards the payload", async () => {
    const payload = { title: "t", body: "b", tag: "srv" };
    await api.notifications.show(payload);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("notifications:show", payload);
  });

  it("notifications.onClick subscribes and parses the tag", () => {
    const cb = vi.fn();
    api.notifications.onClick(cb);
    emitRendererEvent("notifications:clicked", "server-7");
    expect(cb).toHaveBeenCalledWith("server-7");
    expect(() => emitRendererEvent("notifications:clicked", 123)).toThrow();
  });

  it("updates.onUpdateReady subscribes and parses the update info", () => {
    const cb = vi.fn();
    api.updates.onUpdateReady(cb);
    emitRendererEvent("update://ready", { version: "2.0.0" });
    expect(cb).toHaveBeenCalledWith({ version: "2.0.0" });
  });

  it("updates.restartToUpdate + shell channels invoke their channels", async () => {
    await api.updates.restartToUpdate();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("updates:restartToUpdate");
    await api.shell.setBadge(3);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("shell:setBadge", 3);
    await api.shell.focusWindow();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("shell:focusWindow");
  });
});
