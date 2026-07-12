import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import {
  notificationArgSchema,
  selectSourceArgSchema,
  setBadgeArgSchema,
  setTokenArgSchema,
} from "@tavern/shared";
import type { ScreenAccessStatus, ScreenSource } from "@tavern/shared";

// Main-side implementations the bridge dispatches to. Kept injectable so the bridge concern
// (origin check + zod parse + dispatch) is tested in isolation from capture/secrets/etc.
export interface IpcServices {
  secrets: { getToken(): Promise<string | null>; setToken(token: string | null): Promise<void> };
  capture: {
    getScreenSources(): Promise<ScreenSource[]>;
    selectSource(id: string | null): Promise<void>;
    loopbackAudioSupported(): boolean | Promise<boolean>;
    screenAccessStatus(): Promise<ScreenAccessStatus>;
    openScreenRecordingSettings(): Promise<void>;
    prepareStreamAudio(): Promise<boolean>;
    releaseStreamAudio(): Promise<void>;
  };
  notifications: {
    show(payload: { title: string; body: string; tag: string }): void | Promise<void>;
  };
  updates: { restartToUpdate(): void | Promise<void> };
  shell: {
    setBadge(count: number | null): void | Promise<void>;
    focusWindow(): void | Promise<void>;
  };
}

// checklist #17 — only frames actually serving the Tavern renderer may drive IPC.
export function isTrustedSenderUrl(url: string): boolean {
  if (url.startsWith("app://tavern")) return true;
  const rendererUrl = process.env.TAVERN_RENDERER_URL;
  return rendererUrl !== undefined && rendererUrl.length > 0 && url.startsWith(rendererUrl);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!isTrustedSenderUrl(url)) {
    throw new Error("tavern-ipc: rejected invoke from untrusted frame");
  }
}

export function registerIpc(services: IpcServices): void {
  ipcMain.handle("secrets:getToken", async (event) => {
    assertTrustedSender(event);
    return services.secrets.getToken();
  });
  ipcMain.handle("secrets:setToken", async (event, arg: unknown) => {
    assertTrustedSender(event);
    return services.secrets.setToken(setTokenArgSchema.parse(arg));
  });
  ipcMain.handle("capture:getScreenSources", async (event) => {
    assertTrustedSender(event);
    return services.capture.getScreenSources();
  });
  ipcMain.handle("capture:selectSource", async (event, arg: unknown) => {
    assertTrustedSender(event);
    return services.capture.selectSource(selectSourceArgSchema.parse(arg));
  });
  ipcMain.handle("capture:loopbackAudioSupported", async (event) => {
    assertTrustedSender(event);
    return services.capture.loopbackAudioSupported();
  });
  ipcMain.handle("capture:screenAccessStatus", async (event) => {
    assertTrustedSender(event);
    return services.capture.screenAccessStatus();
  });
  ipcMain.handle("capture:openScreenRecordingSettings", async (event) => {
    assertTrustedSender(event);
    return services.capture.openScreenRecordingSettings();
  });
  ipcMain.handle("capture:prepareStreamAudio", async (event) => {
    assertTrustedSender(event);
    return services.capture.prepareStreamAudio();
  });
  ipcMain.handle("capture:releaseStreamAudio", async (event) => {
    assertTrustedSender(event);
    return services.capture.releaseStreamAudio();
  });
  ipcMain.handle("notifications:show", async (event, arg: unknown) => {
    assertTrustedSender(event);
    return services.notifications.show(notificationArgSchema.parse(arg));
  });
  ipcMain.handle("updates:restartToUpdate", async (event) => {
    assertTrustedSender(event);
    return services.updates.restartToUpdate();
  });
  ipcMain.handle("shell:setBadge", async (event, arg: unknown) => {
    assertTrustedSender(event);
    return services.shell.setBadge(setBadgeArgSchema.parse(arg));
  });
  ipcMain.handle("shell:focusWindow", async (event) => {
    assertTrustedSender(event);
    return services.shell.focusWindow();
  });
}
