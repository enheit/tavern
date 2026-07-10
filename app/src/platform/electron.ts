import type { TavernIpc } from "@tavern/shared";
import {
  notificationArgSchema,
  selectSourceArgSchema,
  setBadgeArgSchema,
  setTokenArgSchema,
} from "@tavern/shared";
import type { PlatformBridge } from "./types";

// The SOLE `window.tavern` reference in the app (S4.3 STOP condition). Every platform-conditional
// funnels through this module — features import the abstract `platform` from ./types, never here.
declare global {
  interface Window {
    tavern?: TavernIpc;
  }
}

// Returns the desktop IPC surface when running inside the Electron shell, undefined on the web.
export function desktopIpc(): TavernIpc | undefined {
  return typeof window === "undefined" ? undefined : window.tavern;
}

// Adapts the desktop `window.tavern` (S4.1 IPC) to the abstract PlatformBridge. Outbound args are
// re-validated against the §6.3 zod schemas at this seam (renderer validates outbound; §9.8).
export function createElectronPlatform(ipc: TavernIpc): PlatformBridge {
  const clickCallbacks = new Set<(tag: string) => void>();
  let clickWired = false;
  const wireClick = (): void => {
    if (clickWired) return;
    clickWired = true;
    ipc.notifications.onClick((tag) => {
      for (const cb of clickCallbacks) cb(tag);
    });
  };

  const updateCallbacks = new Set<() => void>();
  let updateWired = false;
  const wireUpdate = (): void => {
    if (updateWired) return;
    updateWired = true;
    ipc.updates.onUpdateReady(() => {
      for (const cb of updateCallbacks) cb();
    });
  };

  return {
    kind: "desktop",
    secrets: {
      getToken: () => ipc.secrets.getToken(),
      setToken: (t) => ipc.secrets.setToken(setTokenArgSchema.parse(t)),
    },
    capture: {
      getScreenSources: () => ipc.capture.getScreenSources(),
      selectSource: (id) => ipc.capture.selectSource(selectSourceArgSchema.parse(id)),
      loopbackAudioSupported: () => ipc.capture.loopbackAudioSupported(),
    },
    notifications: {
      show: (n) => ipc.notifications.show(notificationArgSchema.parse(n)),
      onClick: (cb) => {
        wireClick();
        clickCallbacks.add(cb);
        return () => {
          clickCallbacks.delete(cb);
        };
      },
    },
    updates: {
      onUpdateReady: (cb) => {
        wireUpdate();
        updateCallbacks.add(cb);
        return () => {
          updateCallbacks.delete(cb);
        };
      },
      restartToUpdate: () => {
        void ipc.updates.restartToUpdate();
      },
    },
    shell: {
      setBadge: (count) => {
        void ipc.shell.setBadge(setBadgeArgSchema.parse(count));
      },
      focusWindow: () => {
        void ipc.shell.focusWindow();
      },
    },
  };
}
