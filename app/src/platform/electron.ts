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

  const updateCallbacks = new Set<(info: { version: string }) => void>();
  let updateWired = false;
  const wireUpdate = (): void => {
    if (updateWired) return;
    updateWired = true;
    ipc.updates.onUpdateReady((info) => {
      for (const cb of updateCallbacks) cb(info);
    });
  };

  return {
    kind: "desktop",
    isE2E: ipc.isE2E,
    os: ipc.platform,
    secrets: {
      getToken: () => ipc.secrets.getToken(),
      setToken: (t) => ipc.secrets.setToken(setTokenArgSchema.parse(t)),
    },
    capture: {
      getScreenSources: () => ipc.capture.getScreenSources(),
      selectSource: (id) => ipc.capture.selectSource(selectSourceArgSchema.parse(id)),
      loopbackAudioSupported: () => ipc.capture.loopbackAudioSupported(),
      loopbackSelfAudioExcluded: ipc.loopbackSelfAudioExcluded,
      screenAccessStatus: () => ipc.capture.screenAccessStatus(),
      openScreenRecordingSettings: () => {
        void ipc.capture.openScreenRecordingSettings();
      },
      prepareStreamAudio: () => ipc.capture.prepareStreamAudio(),
      releaseStreamAudio: () => {
        void ipc.capture.releaseStreamAudio();
      },
    },
    notifications: {
      show: (n) => {
        // Same §10 test hook as the web bridge: under TAVERN_E2E the renderer records notifications
        // in the injected sink instead of routing to the main-process Notification.
        // oxlint-disable-next-line no-underscore-dangle -- pinned S6.2 e2e notification test-hook global
        const sink = typeof window === "undefined" ? undefined : window.__tavernTestNotifications;
        if (sink !== undefined) {
          sink.push({ title: n.title, body: n.body, serverId: n.tag });
          return Promise.resolve();
        }
        return ipc.notifications.show(notificationArgSchema.parse(n));
      },
      onClick: (cb) => {
        wireClick();
        clickCallbacks.add(cb);
        return () => {
          clickCallbacks.delete(cb);
        };
      },
      // Desktop notifications are shown by the main process at the OS level — no browser permission
      // gate — so enabling a toggle is always allowed.
      requestPermission: () => Promise.resolve(true),
      // No renderer-side permission gate on desktop (the OS owns it, and the main process shows
      // notifications unconditionally), so there is never a pending request to make.
      permissionState: () => "granted",
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
