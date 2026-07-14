import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import {
  createWindow,
  focusMainWindow,
  getMainWindow,
  installNavigationGuards,
  setAppBadge,
} from "../src/main/window";
import { BrowserWindow, FakeWebContents, app, resetElectronMock, shell } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

// The mock only implements the two members installNavigationGuards uses; cast as a test double.
function asWebContents(contents: FakeWebContents): WebContents {
  return contents as unknown as WebContents;
}

describe("window shell + navigation lockdown", () => {
  beforeEach(() => {
    resetElectronMock();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a locked-down BrowserWindow and shows it on ready-to-show", () => {
    createWindow();
    const win = BrowserWindow.instances[0];
    expect(win).toBeDefined();
    if (win === undefined) return;

    expect(win.options).toMatchObject({
      // The initial dimensions are the renderer viewport. This keeps the grid's chat column fully
      // available on Windows, where native title-bar chrome is outside the web contents.
      useContentSize: true,
      width: 1280,
      height: 800,
      minWidth: 940,
      minHeight: 560,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#111111",
      title: "Tavern",
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    expect(win.loadURL).toHaveBeenCalledWith("app://tavern/index.html");
    expect(getMainWindow()).toBe(win);

    expect(win.show).not.toHaveBeenCalled();
    win.emit("ready-to-show");
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it("loads the dev renderer URL when TAVERN_RENDERER_URL is set", () => {
    vi.stubEnv("TAVERN_RENDERER_URL", "http://localhost:5173");
    createWindow();
    const win = BrowserWindow.instances[0];
    expect(win?.loadURL).toHaveBeenCalledWith("http://localhost:5173");
  });

  it("focusMainWindow restores a minimized window then focuses it", () => {
    createWindow();
    const win = BrowserWindow.instances[0];
    if (win === undefined) throw new Error("no window");
    win.minimized = true;
    focusMainWindow();
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("setAppBadge maps null to 0", () => {
    setAppBadge(4);
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(4);
    setAppBadge(null);
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it("uses a taskbar overlay icon on Windows", () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      createWindow();
      const win = BrowserWindow.instances[0];
      if (win === undefined) throw new Error("no window");
      setAppBadge(2);
      expect(win.setOverlayIcon).toHaveBeenLastCalledWith(expect.anything(), "2 unread messages");
      setAppBadge(null);
      expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("blocks navigation to a foreign origin, allows same-origin", () => {
    const contents = new FakeWebContents();
    installNavigationGuards(asWebContents(contents));
    const willNavigate = contents.handlers.get("will-navigate");
    expect(willNavigate).toBeDefined();
    if (willNavigate === undefined) return;

    const foreign = { preventDefault: vi.fn() };
    willNavigate(foreign, "https://evil.example/x");
    expect(foreign.preventDefault).toHaveBeenCalledTimes(1);

    const same = { preventDefault: vi.fn() };
    willNavigate(same, "app://tavern/servers/1");
    expect(same.preventDefault).not.toHaveBeenCalled();
  });

  it("denies window.open and opens only https: targets externally", () => {
    const contents = new FakeWebContents();
    installNavigationGuards(asWebContents(contents));
    const handler = contents.windowOpenHandler;
    expect(handler).not.toBeNull();
    if (handler === null) return;

    expect(handler({ url: "https://example.com" })).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledWith("https://example.com");

    shell.openExternal.mockClear();
    expect(handler({ url: "http://insecure.example" })).toEqual({ action: "deny" });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
