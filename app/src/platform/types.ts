import type { ScreenSource } from "@tavern/shared";
import { createElectronPlatform, desktopIpc } from "./electron";
import { createWebPlatform } from "./web";

// The ONE abstraction over desktop/web differences (A1). S5+ features import ONLY from this module
// (`platform` and `PlatformBridge`) — never the raw desktop bridge, never a raw `if (isElectron)`.
export interface PlatformBridge {
  kind: "desktop" | "web";
  // §10 hermeticity: true under the e2e harness (desktop reads window.tavern.isE2E; web reads the
  // `?e2e=1` query param). The voice controller installs the test hooks only when this is set.
  isE2E: boolean;
  // The concrete OS on desktop (from window.tavern.platform), or "web" in the browser. Features must
  // read this only through the bridge (A1) — e.g. FR-28 hides the loopback-audio switch on Linux v1.
  os: "win32" | "darwin" | "linux" | "web";
  secrets: { getToken(): Promise<string | null>; setToken(t: string | null): Promise<void> };
  capture: {
    getScreenSources(): Promise<ScreenSource[]>;
    selectSource(id: string | null): Promise<void>;
    loopbackAudioSupported(): Promise<boolean>;
  };
  notifications: {
    show(n: { title: string; body: string; tag: string }): Promise<void>;
    onClick(cb: (tag: string) => void): () => void;
    // FR-16: request OS/browser permission on the user gesture of enabling a notification toggle.
    // Resolves true when notifications may be shown (desktop is always allowed; web reflects the
    // Notification permission). The renderer never touches the raw Notification API — this stays the
    // only route (A1/A10).
    requestPermission(): Promise<boolean>;
  };
  updates: { onUpdateReady(cb: () => void): () => void; restartToUpdate(): void };
  shell: { setBadge(count: number | null): void; focusWindow(): void };
}

// Selected once at module load by `window.tavern` presence (via desktopIpc()); frozen thereafter.
const ipc = desktopIpc();
export const platform: PlatformBridge = ipc ? createElectronPlatform(ipc) : createWebPlatform();
