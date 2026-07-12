import { Notification, app } from "electron";
import { focusMainWindow, getMainWindow } from "./window";

const APP_USER_MODEL_ID = "com.tavern.app";
const CLICKED_CHANNEL = "notifications:clicked";

// win32 needs an explicit AppUserModelID or notifications are attributed to the wrong app.
export function setupNotifications(): void {
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
}

export function showNotification(payload: { title: string; body: string; tag: string }): void {
  // Linux without a notification daemon (and any other host lacking OS support) reports false here;
  // constructing/showing would throw or silently drop, so bail cleanly instead.
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: payload.title, body: payload.body });
  notification.on("click", () => {
    focusMainWindow();
    const win = getMainWindow();
    if (win !== null) win.webContents.send(CLICKED_CHANNEL, payload.tag);
  });
  notification.show();
}
