import type { ScreenSource } from "@tavern/shared";
import { createElectronPlatform, desktopIpc } from "./electron";
import { createWebPlatform } from "./web";

// The ONE abstraction over desktop/web differences (A1). S5+ features import ONLY from this module
// (`platform` and `PlatformBridge`) — never the raw desktop bridge, never a raw `if (isElectron)`.
export interface PlatformBridge {
  kind: "desktop" | "web";
  secrets: { getToken(): Promise<string | null>; setToken(t: string | null): Promise<void> };
  capture: {
    getScreenSources(): Promise<ScreenSource[]>;
    selectSource(id: string | null): Promise<void>;
    loopbackAudioSupported(): Promise<boolean>;
  };
  notifications: {
    show(n: { title: string; body: string; tag: string }): Promise<void>;
    onClick(cb: (tag: string) => void): () => void;
  };
  updates: { onUpdateReady(cb: () => void): () => void; restartToUpdate(): void };
  shell: { setBadge(count: number | null): void; focusWindow(): void };
}

// Selected once at module load by `window.tavern` presence (via desktopIpc()); frozen thereafter.
const ipc = desktopIpc();
export const platform: PlatformBridge = ipc ? createElectronPlatform(ipc) : createWebPlatform();
