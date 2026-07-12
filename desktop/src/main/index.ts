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
import { acquireSingleInstanceLock } from "./singleInstance";
import { initUpdates, restartToUpdate } from "./updates";
import { createWindow, focusMainWindow, setAppBadge } from "./window";

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

  // FR-28: never leave the share's pulse remap-source behind on quit (idempotent off-linux no-op).
  app.on("will-quit", () => {
    void releaseStreamAudio();
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
    initUpdates(win);
  });
}
