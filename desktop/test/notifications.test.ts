import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupNotifications, showNotification } from "../src/main/notifications";
import { createWindow } from "../src/main/window";
import { BrowserWindow, Notification, app, resetElectronMock } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("FR-16 notification transport", () => {
  beforeEach(() => {
    resetElectronMock();
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("does not send on click when there is no window (no throw)", () => {
    showNotification({ title: "t", body: "b", tag: "srv-1" });
    const notification = Notification.instances[0];
    expect(notification).toBeDefined();
    expect(() => notification?.emit("click")).not.toThrow();
  });

  it("sets the win32 AppUserModelId, and only on win32", () => {
    setPlatform("win32");
    setupNotifications();
    expect(app.setAppUserModelId).toHaveBeenCalledWith("com.tavern.app");

    app.setAppUserModelId.mockClear();
    setPlatform("darwin");
    setupNotifications();
    expect(app.setAppUserModelId).not.toHaveBeenCalled();
  });

  it("shows a notification and, on click, focuses the window and forwards the tag", () => {
    createWindow();
    const win = BrowserWindow.instances[0];
    if (win === undefined) throw new Error("no window");

    showNotification({ title: "New message", body: "hello", tag: "server-42" });
    const notification = Notification.instances[0];
    expect(notification?.options).toEqual({ title: "New message", body: "hello" });
    expect(notification?.show).toHaveBeenCalledTimes(1);

    notification?.emit("click");
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith("notifications:clicked", "server-42");
  });
});
