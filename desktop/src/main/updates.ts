import { app } from "electron";
import type { BrowserWindow } from "electron";

// v1 STUB with the FINAL surface frozen. The 'update://ready' channel string is pinned by PLAN
// §6.3; S12.2 fills the electron-updater body and emits on this exact string.
export const UPDATE_READY_CHANNEL = "update://ready";

export function initUpdates(win: BrowserWindow): void {
  if (!app.isPackaged) return;
  // Frozen: S12.2 sends this once electron-updater reports a downloaded, ready-to-install update.
  win.webContents.send(UPDATE_READY_CHANNEL, { version: app.getVersion() });
}

export async function restartToUpdate(): Promise<void> {
  // No-op in v1. S12.2 calls autoUpdater.quitAndInstall() here.
}
