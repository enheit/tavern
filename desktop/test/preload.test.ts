import { beforeEach, describe, expect, it, vi } from "vitest";
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
      ["capture", "notifications", "platform", "secrets", "shell", "updates"].toSorted(),
    );
    expect("ipcRenderer" in api).toBe(false);
    expect("on" in api).toBe(false);
    expect("invoke" in api).toBe(false);
  });

  it("reports a valid platform parsed from process.platform", () => {
    expect(["win32", "darwin", "linux"]).toContain(api.platform);
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

  it("capture.selectSource + loopbackAudioSupported round-trip", async () => {
    await api.capture.selectSource("screen:1");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:selectSource", "screen:1");

    state.invokeResults.set("capture:loopbackAudioSupported", true);
    expect(await api.capture.loopbackAudioSupported()).toBe(true);
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
