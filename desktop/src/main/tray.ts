import { Menu, Tray, app, nativeImage } from "electron";
import { markQuitting } from "./lifecycle";
import { showMainWindow } from "./window";
import { TRAY_ICON_PNG_DATA_URL, TRAY_ICON_TEMPLATE_PNG_DATA_URL } from "./trayIcon";

let tray: Tray | null = null;

function trayImage(): Electron.NativeImage {
  // macOS wants a template image — a black+alpha silhouette the menu bar tints to the current theme
  // (dark on light, white on dark). Windows/Linux have no such convention, so they get the colour
  // (orange) nose. The source PNGs are 64px; the tray wants ~18px, so resize here rather than hand
  // the OS an oversized image to squash.
  const isMac = process.platform === "darwin";
  const image = nativeImage
    .createFromDataURL(isMac ? TRAY_ICON_TEMPLATE_PNG_DATA_URL : TRAY_ICON_PNG_DATA_URL)
    .resize({ width: 18, height: 18 });
  if (isMac) image.setTemplateImage(true);
  return image;
}

// Builds the tray with a minimal Open/Exit menu (per the request: nothing else). Left-clicking the
// icon also shows the window — the platform-native affordance on Windows/Linux where the context
// menu is right-click only.
export function createTray(): Tray {
  const icon = trayImage();
  tray = new Tray(icon);
  tray.setToolTip("Tavern");

  const menu = Menu.buildFromTemplate([
    { label: "Open Tavern", click: () => showMainWindow() },
    { type: "separator" },
    {
      label: "Exit",
      click: () => {
        markQuitting();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => showMainWindow());

  return tray;
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
