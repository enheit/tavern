import { join } from "node:path";
import { app } from "electron";
import {
  getScreenSources,
  loopbackAudioSupported,
  openScreenRecordingSettings,
  prepareStreamAudio,
  releaseStreamAudio,
  screenAccessStatus,
  selectSource,
  setupDisplayMediaHandler,
} from "./capture";
import { applyFlags, registerGpuCrashGuard } from "./flags";
import { registerIpc } from "./ipc";
import type { IpcServices } from "./ipc";
import { setupNotifications, showNotification } from "./notifications";
import { registerPermissions } from "./permissions";
import { registerAppProtocolHandler, registerAppScheme } from "./protocol";
import { getToken, setToken } from "./secrets";
import { markQuitting } from "./lifecycle";
import { acquireSingleInstanceLock } from "./singleInstance";
import { createTray, destroyTray } from "./tray";
import { initUpdates, restartToUpdate } from "./updates";
import { shutdownVenmic } from "./venmic";
import { createWindow, focusMainWindow, setAppBadge, showMainWindow } from "./window";

function buildServices(): IpcServices {
  return {
    secrets: { getToken, setToken },
    capture: {
      getScreenSources,
      selectSource,
      loopbackAudioSupported,
      screenAccessStatus,
      openScreenRecordingSettings,
      prepareStreamAudio: () => prepareStreamAudio(),
      releaseStreamAudio: () => releaseStreamAudio(),
    },
    notifications: { show: showNotification },
    updates: { restartToUpdate },
    shell: {
      setBadge: (count) => {
        setAppBadge(count);
      },
      focusWindow: () => {
        focusMainWindow();
      },
    },
  };
}

// Startup order is pinned (§4 / S4.1): env+flags → single-instance gate → protocol registration →
// whenReady → permissions → ipc → window.
applyFlags();

if (!acquireSingleInstanceLock()) {
  app.quit();
} else {
  registerAppScheme();

  // Close-to-tray gate: the window's close handler swallows normal closes into a hide-to-tray, so
  // every genuine quit (tray "Exit", Cmd+Q, auto-update quitAndInstall) must announce itself here
  // first — `before-quit` fires ahead of window close on all of those paths.
  app.on("before-quit", () => {
    markQuitting();
  });

  // macOS keeps the process alive after the window is hidden/closed; re-activating from the dock (or
  // clicking the tray) should bring the hidden window back rather than doing nothing.
  app.on("activate", () => {
    showMainWindow();
  });

  // FR-28: never leave the share's pulse remap-source behind on quit (idempotent off-linux no-op),
  // and take the venmic utilityProcess down with the app.
  app.on("will-quit", () => {
    destroyTray();
    void releaseStreamAudio();
    shutdownVenmic();
  });

  void app.whenReady().then(() => {
    // Dev runs the stock Electron binary whose bundle supplies the Dock icon; build/icon.png is
    // only applied by electron-builder at package time, so in dev set the Dock icon at runtime.
    if (!app.isPackaged && process.platform === "darwin") {
      app.dock?.setIcon(join(app.getAppPath(), "build", "icon.png"));
    }
    registerGpuCrashGuard();
    registerPermissions();
    registerAppProtocolHandler();
    setupDisplayMediaHandler();
    setupNotifications();
    registerIpc(buildServices());
    const win = createWindow();
    createTray();
    initUpdates(win);
  });
}
