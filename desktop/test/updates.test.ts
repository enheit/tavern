import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { UPDATE_READY_CHANNEL, initUpdates, restartToUpdate } from "../src/main/updates";
import { BrowserWindow, resetElectronMock, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

function fakeWindow(): { win: ElectronBrowserWindow; send: BrowserWindow["webContents"]["send"] } {
  const win = new BrowserWindow({});
  return { win: win as unknown as ElectronBrowserWindow, send: win.webContents.send };
}

describe("FR-44 update plumbing", () => {
  beforeEach(() => {
    resetElectronMock();
  });

  it("freezes the update://ready channel string", () => {
    expect(UPDATE_READY_CHANNEL).toBe("update://ready");
  });

  it("no-ops when the app is not packaged", () => {
    state.isPackaged = false;
    const { win, send } = fakeWindow();
    initUpdates(win);
    expect(send).not.toHaveBeenCalled();
  });

  it("emits update://ready with the app version when packaged", () => {
    state.isPackaged = true;
    state.version = "3.1.4";
    const { win, send } = fakeWindow();
    initUpdates(win);
    expect(send).toHaveBeenCalledWith("update://ready", { version: "3.1.4" });
  });

  it("restartToUpdate is a resolved no-op in v1", async () => {
    await expect(restartToUpdate()).resolves.toBeUndefined();
  });
});
