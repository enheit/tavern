import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRAY_ICON_PNG_DATA_URL, TRAY_ICON_TEMPLATE_PNG_DATA_URL } from "../src/main/trayIcon";
import type { FakeNativeImage, MenuItemTemplate } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

const realPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

// The lifecycle module holds a process-wide "quitting" flag as module state. Each test re-imports a
// fresh module graph (vi.resetModules) so that flag — and the tray/window singletons — start clean,
// which lets the "close hides" and "close is allowed while quitting" cases share no state.
async function setup() {
  vi.resetModules();
  let closeToTray = true;
  vi.doMock("../src/main/preferences", () => ({
    getCloseToTray: () => closeToTray,
    setCloseToTray: (value: boolean) => {
      closeToTray = value;
    },
  }));
  // Pull the mock through the mocked "electron" specifier (not "./electron-mock" directly): after
  // resetModules those two resolve to different instances, and the SUT sees the one the mock factory
  // returns — so we must inspect that same one.
  const electron = (await import("electron")) as unknown as typeof import("./electron-mock");
  electron.resetElectronMock();
  const lifecycle = await import("../src/main/lifecycle");
  const preferences = await import("../src/main/preferences");
  const windowMod = await import("../src/main/window");
  const trayMod = await import("../src/main/tray");
  return { electron, lifecycle, preferences, windowMod, trayMod };
}

function itemByLabel(template: MenuItemTemplate[], label: string): MenuItemTemplate {
  const item = template.find((entry) => entry.label === label);
  if (item === undefined) throw new Error(`menu item "${label}" not found`);
  return item;
}

describe("system tray", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("builds a tray with an Open/Exit menu and a tooltip", async () => {
    setPlatform("linux");
    const { electron, trayMod } = await setup();
    trayMod.createTray();

    const tray = electron.Tray.instances[0];
    if (tray === undefined) throw new Error("no tray");
    expect(tray.toolTip).toBe("Tavern");

    const template = tray.contextMenu?.template ?? [];
    expect(template.map((entry) => entry.label ?? entry.type)).toEqual([
      "Open Tavern",
      "separator",
      "Exit",
    ]);
  });

  it("uses a theme-adaptive template image on macOS", async () => {
    setPlatform("darwin");
    const { electron, trayMod } = await setup();
    trayMod.createTray();

    expect(electron.nativeImage.createFromDataURL).toHaveBeenCalledWith(
      TRAY_ICON_TEMPLATE_PNG_DATA_URL,
    );
    const image = electron.Tray.instances[0]?.image as FakeNativeImage | undefined;
    expect(image?.template).toBe(true);
  });

  it("uses the colour icon on Windows/Linux", async () => {
    setPlatform("win32");
    const { electron, trayMod } = await setup();
    trayMod.createTray();

    expect(electron.nativeImage.createFromDataURL).toHaveBeenCalledWith(TRAY_ICON_PNG_DATA_URL);
    const image = electron.Tray.instances[0]?.image as FakeNativeImage | undefined;
    expect(image?.template).toBe(false);
  });

  it("Open menu item and tray click both reveal a window hidden to the tray", async () => {
    const { electron, windowMod, trayMod } = await setup();
    windowMod.createWindow();
    trayMod.createTray();
    const win = electron.BrowserWindow.instances[0];
    const tray = electron.Tray.instances[0];
    if (win === undefined || tray === undefined) throw new Error("no window/tray");

    // Simulate the window having been closed-to-tray.
    win.hide();
    expect(win.isVisible()).toBe(false);

    itemByLabel(tray.contextMenu?.template ?? [], "Open Tavern").click?.();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);

    win.hide();
    tray.emit("click");
    expect(win.show).toHaveBeenCalledTimes(2);
    expect(win.focus).toHaveBeenCalledTimes(2);
  });

  it("Exit menu item marks the app quitting and quits", async () => {
    const { electron, lifecycle, trayMod } = await setup();
    trayMod.createTray();
    const tray = electron.Tray.instances[0];
    if (tray === undefined) throw new Error("no tray");

    expect(lifecycle.isQuittingApp()).toBe(false);
    itemByLabel(tray.contextMenu?.template ?? [], "Exit").click?.();
    expect(lifecycle.isQuittingApp()).toBe(true);
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
  });

  it("destroyTray tears the tray down", async () => {
    const { electron, trayMod } = await setup();
    trayMod.createTray();
    const tray = electron.Tray.instances[0];
    if (tray === undefined) throw new Error("no tray");

    trayMod.destroyTray();
    expect(tray.destroy).toHaveBeenCalledTimes(1);
  });

  it("shows and clears unread state on the tray icon and tooltip", async () => {
    const { electron, trayMod } = await setup();
    trayMod.createTray();
    const tray = electron.Tray.instances[0];
    if (tray === undefined) throw new Error("no tray");

    trayMod.setTrayUnread(3);
    expect(tray.setImage).toHaveBeenCalledTimes(1);
    expect(tray.toolTip).toBe("Tavern - 3 unread");
    trayMod.setTrayUnread(0);
    expect(tray.setImage).toHaveBeenCalledTimes(2);
    expect(tray.toolTip).toBe("Tavern");
  });
});

describe("close-to-tray", () => {
  it("hides the window instead of destroying it on a normal close", async () => {
    const { electron, preferences, windowMod } = await setup();
    preferences.setCloseToTray(true);
    windowMod.createWindow();
    const win = electron.BrowserWindow.instances[0];
    if (win === undefined) throw new Error("no window");

    const event = { preventDefault: vi.fn() };
    win.emit("close", event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  it("quits the application when close-to-tray is disabled", async () => {
    const { electron, lifecycle, preferences, windowMod } = await setup();
    preferences.setCloseToTray(false);
    windowMod.createWindow();
    const win = electron.BrowserWindow.instances[0];
    if (win === undefined) throw new Error("no window");

    const event = { preventDefault: vi.fn() };
    win.emit("close", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
    expect(lifecycle.isQuittingApp()).toBe(true);
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
  });

  it("lets the close through once the app is quitting", async () => {
    const { electron, lifecycle, windowMod } = await setup();
    windowMod.createWindow();
    const win = electron.BrowserWindow.instances[0];
    if (win === undefined) throw new Error("no window");

    lifecycle.markQuitting();
    const event = { preventDefault: vi.fn() };
    win.emit("close", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
  });

  it("showMainWindow reveals a tray-hidden window and focuses it", async () => {
    const { electron, windowMod } = await setup();
    windowMod.createWindow();
    const win = electron.BrowserWindow.instances[0];
    if (win === undefined) throw new Error("no window");

    win.hide();
    windowMod.showMainWindow();
    expect(win.show).toHaveBeenCalled();
    expect(win.isVisible()).toBe(true);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("showMainWindow restores a minimized window", async () => {
    const { electron, windowMod } = await setup();
    windowMod.createWindow();
    const win = electron.BrowserWindow.instances[0];
    if (win === undefined) throw new Error("no window");

    win.minimized = true;
    windowMod.showMainWindow();
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });
});
