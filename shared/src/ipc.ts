import { z } from "zod";

// The window.tavern contract (PLAN §6.3). Desktop-only surface; the renderer-side PlatformBridge
// (S4.3) wraps this and adds kind:'desktop'|'web' — that name is NOT defined here.

export const platformSchema = z.enum(["win32", "darwin", "linux"]);

export const ScreenSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  thumbnailDataUrl: z.string(),
  appIcon: z.string().optional(),
});
export type ScreenSource = z.infer<typeof ScreenSourceSchema>;

export const setTokenArgSchema = z.union([z.string(), z.null()]);
export const selectSourceArgSchema = z.union([z.string(), z.null()]);
export const notificationArgSchema = z.object({
  title: z.string(),
  body: z.string(),
  tag: z.string(),
});
export const updateInfoSchema = z.object({ version: z.string() });
export const setBadgeArgSchema = z.union([z.number(), z.null()]);

export interface TavernIpc {
  platform: "win32" | "darwin" | "linux";
  // Static e2e flag (§10 hermeticity): the desktop main sets it from TAVERN_E2E so the renderer can
  // install the test hooks (testHooks.ts). Like `platform`, it is a value read once at preload load,
  // not an IPC channel — so it adds no invoke/push channel to the frozen S4.1 surface.
  isE2E: boolean;
  secrets: { getToken(): Promise<string | null>; setToken(t: string | null): Promise<void> };
  capture: {
    getScreenSources(): Promise<ScreenSource[]>;
    selectSource(id: string | null): Promise<void>;
    loopbackAudioSupported(): Promise<boolean>;
  };
  notifications: {
    show(n: { title: string; body: string; tag: string }): Promise<void>;
    onClick(cb: (tag: string) => void): void;
  };
  updates: {
    onUpdateReady(cb: (info: { version: string }) => void): void;
    restartToUpdate(): Promise<void>;
  };
  shell: { setBadge(count: number | null): Promise<void>; focusWindow(): Promise<void> };
}
