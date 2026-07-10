import { app } from "electron";
import {
  getScreenSources,
  loopbackAudioSupported,
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
    capture: { getScreenSources, selectSource, loopbackAudioSupported },
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

  void app.whenReady().then(() => {
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
