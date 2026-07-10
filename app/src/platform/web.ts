import type { PlatformBridge } from "./types";

// The web implementation of PlatformBridge (FR-42): browser APIs only. No system-audio loopback,
// no auto-update, secrets live in same-origin cookies (so the token store is a no-op here).
export function createWebPlatform(): PlatformBridge {
  const clickCallbacks = new Set<(tag: string) => void>();
  const updateCallbacks = new Set<() => void>();

  return {
    kind: "web",
    secrets: {
      // Same-origin cookies carry the session; there is no client-held bearer token to read.
      getToken: async () => null,
      setToken: async () => {
        // cookie mode: nothing to persist client-side.
      },
    },
    capture: {
      // Screen capture on the web goes through the browser's native getDisplayMedia picker, so
      // there is no enumerable source list and no source to pre-select.
      getScreenSources: async () => [],
      selectSource: async () => {
        // native picker — no source to arm.
      },
      loopbackAudioSupported: async () => false,
    },
    notifications: {
      show: async (n) => {
        if (typeof Notification === "undefined") return;
        if (Notification.permission === "default") await Notification.requestPermission();
        if (Notification.permission !== "granted") return;
        const notification = new Notification(n.title, { body: n.body, tag: n.tag });
        notification.addEventListener("click", () => {
          for (const cb of clickCallbacks) cb(n.tag);
        });
      },
      onClick: (cb) => {
        clickCallbacks.add(cb);
        return () => {
          clickCallbacks.delete(cb);
        };
      },
    },
    updates: {
      // Web never auto-updates; keep the handler registered so the contract's unsubscribe is real.
      onUpdateReady: (cb) => {
        updateCallbacks.add(cb);
        return () => {
          updateCallbacks.delete(cb);
        };
      },
      restartToUpdate: () => {
        // no auto-update on the web.
      },
    },
    shell: {
      setBadge: () => {
        // reserved for post-v1 unread badges (§6.3) — implemented, never called in v1.
      },
      focusWindow: () => {
        window.focus();
      },
    },
  };
}
