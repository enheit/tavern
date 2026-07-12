import { join } from "node:path";
import { BrowserWindow, app, shell } from "electron";
import type { WebContents } from "electron";
import { isQuittingApp } from "./lifecycle";

const APP_ORIGIN = "app://tavern";

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// Brings the window back from either the tray (hidden) or a minimize, then focuses it. Used by the
// tray "Open" item, tray-icon click, macOS dock re-activation, and notification clicks.
export function showMainWindow(): void {
  const win = mainWindow;
  if (win === null) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

export function focusMainWindow(): void {
  showMainWindow();
}

// RESERVED for post-v1 unread badges (§1.9) — implemented, never called in v1.
export function setAppBadge(count: number | null): void {
  app.setBadgeCount(count ?? 0);
}

// scheme://host origin. `URL.origin` is unusable here: app:// is a non-special scheme so it reports
// an opaque "null" origin — we derive protocol//host so app://tavern navigations stay same-origin.
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

// The origin the window is actually showing — the app:// scheme in prod, or the dev renderer URL.
function loadedOrigin(): string {
  const rendererUrl = process.env.TAVERN_RENDERER_URL;
  if (rendererUrl !== undefined && rendererUrl.length > 0) {
    return originOf(rendererUrl) ?? APP_ORIGIN;
  }
  return APP_ORIGIN;
}

// Navigation lockdown (checklist #13/#14): block in-window navigation to foreign origins; deny all
// window.open, opening only https: targets in the OS browser.
export function installNavigationGuards(contents: WebContents): void {
  const origin = loadedOrigin();
  contents.on("will-navigate", (event, url) => {
    if (originOf(url) !== origin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });
}

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#111111",
    title: "Tavern",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.js"),
    },
  });
  mainWindow = win;

  win.once("ready-to-show", () => {
    win.show();
  });
  // Close-to-tray: a user closing the window (title-bar X, Cmd+W) hides it so the renderer keeps
  // running in the background — voice stays connected and OS notifications still arrive. Only a real
  // quit (tray "Exit", Cmd+Q, auto-update restart — all set the quitting flag via `before-quit`)
  // lets the close through and destroys the window.
  win.on("close", (event) => {
    if (isQuittingApp()) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    mainWindow = null;
  });
  installNavigationGuards(win.webContents);

  const rendererUrl = process.env.TAVERN_RENDERER_URL;
  if (rendererUrl !== undefined && rendererUrl.length > 0) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadURL("app://tavern/index.html");
  }
  return win;
}
