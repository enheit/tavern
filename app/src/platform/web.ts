import type { PlatformBridge } from "./types";

declare global {
  interface Window {
    // FR-16 / §10 notification test hook: under TAVERN_E2E the renderer cannot read the process env,
    // so the e2e injects this array (via addInitScript) as the "TAVERN_E2E=1" signal. When present,
    // both platform bridges record `{ title, body, serverId }` here instead of displaying a real
    // system notification, letting specs assert the decision rule without OS-level notifications.
    __tavernTestNotifications?: { title: string; body: string; serverId: string }[];
  }
}

// The web implementation of PlatformBridge (FR-42): browser APIs only. No system-audio loopback,
// no auto-update, secrets live in same-origin cookies (so the token store is a no-op here).
export function createWebPlatform(): PlatformBridge {
  const clickCallbacks = new Set<(tag: string) => void>();
  const updateCallbacks = new Set<(info: { version: string }) => void>();

  return {
    kind: "web",
    // Web e2e signals the mode with a `?e2e=1` query param on every opened page (the renderer cannot
    // read process env). Guarded for non-browser (SSR/test) contexts where `location` is absent.
    isE2E: typeof location !== "undefined" && new URLSearchParams(location.search).has("e2e"),
    os: "web",
    secrets: {
      // Same-origin cookies carry the session; there is no client-held bearer token to read.
      getToken: async () => null,
      setToken: async () => {
        // cookie mode: nothing to persist client-side.
      },
    },
    capture: {
      // The web picker never renders a grid regardless (the browser's own dialog picks), so the
      // desktop-only portal/grid distinction stays at its "grid" default here.
      sourceMode: "grid",
      // Screen capture on the web goes through the browser's native getDisplayMedia picker, so
      // there is no enumerable source list and no source to pre-select.
      getScreenSources: async () => [],
      selectSource: async () => {
        // native picker — no source to arm.
      },
      loopbackAudioSupported: async () => false,
      // Browser capture (tab/system audio via the native picker) always includes the app's own
      // output — the caveat stands on the web.
      loopbackSelfAudioExcluded: false,
      // The browser's native picker owns its own permission UX — nothing to gate here.
      screenAccessStatus: async () => "granted",
      openScreenRecordingSettings: () => {
        // no OS settings pane reachable from the web.
      },
      // Browsers can't create OS audio sources — the FR-28 fallback captures what already exists.
      prepareStreamAudio: async () => false,
      releaseStreamAudio: () => {
        // nothing to tear down on the web.
      },
    },
    notifications: {
      show: async (n) => {
        // oxlint-disable-next-line no-underscore-dangle -- pinned S6.2 e2e notification test-hook global
        const sink = typeof window === "undefined" ? undefined : window.__tavernTestNotifications;
        if (sink !== undefined) {
          sink.push({ title: n.title, body: n.body, serverId: n.tag });
          return;
        }
        // Permission is requested only on the user gesture of enabling a toggle (requestPermission),
        // never here — show just displays when already granted, otherwise no-ops.
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
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
      requestPermission: async () => {
        if (typeof Notification === "undefined") return false;
        if (Notification.permission === "granted") return true;
        if (Notification.permission === "denied") return false;
        return (await Notification.requestPermission()) === "granted";
      },
      permissionState: () =>
        typeof Notification === "undefined" ? "unsupported" : Notification.permission,
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
