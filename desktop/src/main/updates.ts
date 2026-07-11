import { app } from "electron";
import type { BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

// FR-44 auto-update (PLAN §6.3/§11). The 'update://ready' channel string is pinned by PLAN §6.3 and
// mirrored verbatim in the preload — change either and the pill goes dark silently.
export const UPDATE_READY_CHANNEL = "update://ready";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Build-time constant injected by electron.vite.config.ts (§3.7 mac fallback: '1' disables mac
// updates when no signing certs exist — Squirrel.Mac refuses unsigned updates anyway). The typeof
// guard keeps the module loadable under vitest, where no define runs.
/* oxlint-disable no-underscore-dangle -- pinned S12.2 build-time define __MAC_UPDATES_DISABLED__ */
declare const __MAC_UPDATES_DISABLED__: boolean;
function macUpdatesDisabled(): boolean {
  return typeof __MAC_UPDATES_DISABLED__ !== "undefined" && __MAC_UPDATES_DISABLED__;
}
/* oxlint-enable no-underscore-dangle */

// Init condition pinned by S12.2: packaged AND (not linux OR running from an AppImage — apt/tar
// installs have no self-replace path, PLAN §11) AND NOT (darwin with updates compiled out).
export function updatesEnabled(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === "linux" && (process.env.APPIMAGE ?? "") === "") return false;
  if (process.platform === "darwin" && macUpdatesDisabled()) return false;
  return true;
}

export function initUpdates(win: BrowserWindow): void {
  if (!updatesEnabled()) return;
  // Errors are logged only — no UI; the next 6h interval retries (pinned).
  autoUpdater.on("error", (err) => {
    console.error("tavern-updates: check/download failed", err);
  });
  autoUpdater.on("update-downloaded", (info) => {
    win.webContents.send(UPDATE_READY_CHANNEL, { version: info.version });
  });
  // checkForUpdatesAndNotify is deliberately NOT used (no OS notification; the in-app pill is the
  // only surface). Check on launch + every 6h.
  void autoUpdater.checkForUpdates();
  setInterval(() => {
    void autoUpdater.checkForUpdates();
  }, CHECK_INTERVAL_MS);
}

export async function restartToUpdate(): Promise<void> {
  autoUpdater.quitAndInstall();
}
