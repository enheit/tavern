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
