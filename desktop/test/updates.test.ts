import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { BrowserWindow, resetElectronMock, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

// electron-updater double: captures event listeners so tests can fire update-downloaded.
const updater = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    listeners,
    autoUpdater: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners.set(event, cb);
      }),
      checkForUpdates: vi.fn(() => Promise.resolve(null)),
      quitAndInstall: vi.fn(),
    },
  };
});
vi.mock("electron-updater", () => ({ autoUpdater: updater.autoUpdater }));

import { UPDATE_READY_CHANNEL, initUpdates, restartToUpdate } from "../src/main/updates";

const realPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function fakeWindow(): { win: ElectronBrowserWindow; send: BrowserWindow["webContents"]["send"] } {
  const win = new BrowserWindow({});
  return { win: win as unknown as ElectronBrowserWindow, send: win.webContents.send };
}

describe("FR-44 auto-update gating", () => {
  beforeEach(() => {
    resetElectronMock();
    updater.listeners.clear();
    state.isPackaged = true;
    setPlatform("win32");
    // Fake timers keep the 6h re-check interval from holding the worker open.
    vi.useFakeTimers();
  });

  afterEach(() => {
    setPlatform(realPlatform);
    delete process.env.APPIMAGE;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("freezes the update://ready channel string", () => {
    expect(UPDATE_READY_CHANNEL).toBe("update://ready");
  });

  it("is inert when the app is not packaged", () => {
    state.isPackaged = false;
    initUpdates(fakeWindow().win);
    expect(updater.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.autoUpdater.on).not.toHaveBeenCalled();
  });

  it("is inert on linux without APPIMAGE (apt/tar installs cannot self-replace)", () => {
    setPlatform("linux");
    initUpdates(fakeWindow().win);
    expect(updater.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("runs on linux when APPIMAGE is set", () => {
    setPlatform("linux");
    process.env.APPIMAGE = "/opt/Tavern.AppImage";
    initUpdates(fakeWindow().win);
    expect(updater.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("is inert on darwin when __MAC_UPDATES_DISABLED__ is compiled in (§3.7 fallback)", () => {
    setPlatform("darwin");
    vi.stubGlobal("__MAC_UPDATES_DISABLED__", true);
    initUpdates(fakeWindow().win);
    expect(updater.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("runs on darwin when the flag is off", () => {
    setPlatform("darwin");
    vi.stubGlobal("__MAC_UPDATES_DISABLED__", false);
    initUpdates(fakeWindow().win);
    expect(updater.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("checks on launch and re-checks every 6h", () => {
    initUpdates(fakeWindow().win);
    expect(updater.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(updater.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("forwards update-downloaded as update://ready {version}", () => {
    const { win, send } = fakeWindow();
    initUpdates(win);
    updater.listeners.get("update-downloaded")?.({ version: "0.1.1" });
    expect(send).toHaveBeenCalledWith("update://ready", { version: "0.1.1" });
  });

  it("logs updater errors without rethrowing (no UI; next interval retries)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    initUpdates(fakeWindow().win);
    expect(() => updater.listeners.get("error")?.(new Error("boom"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("restartToUpdate hands off to quitAndInstall", async () => {
    await restartToUpdate();
    expect(updater.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
