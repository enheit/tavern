// Pre-React FOUC guard: applies the persisted theme's `.dark` class to <html> before the
// renderer mounts. Loaded as its own module script in index.html (CSP blocks inline scripts).
// Imports only a type from @tavern/shared, so this stays a tiny standalone chunk (no store/zustand).
import type { Theme } from "@tavern/shared";

export const THEME_STORAGE_KEY = "tavern.theme";

export function readStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // localStorage may be unavailable (privacy mode / SSR) — fall through to the default.
  }
  return "system";
}

export function prefersDark(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function resolveDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && prefersDark());
}

export function applyThemeClass(theme: Theme): void {
  document.documentElement.classList.toggle("dark", resolveDark(theme));
}

// Theme observation starts in this pre-React module rather than in the settings UI/store. That is
// important when `system` was already persisted: both a browser reload and a fresh Electron
// renderer must subscribe before React mounts, without requiring the user to select System again.
let systemMedia: MediaQueryList | undefined;

function onSystemThemeChange(event: MediaQueryListEvent): void {
  document.documentElement.classList.toggle("dark", event.matches);
}

export function activateTheme(theme: Theme): void {
  if (systemMedia) {
    systemMedia.removeEventListener("change", onSystemThemeChange);
    systemMedia = undefined;
  }

  applyThemeClass(theme);

  if (theme === "system" && typeof globalThis.matchMedia === "function") {
    systemMedia = globalThis.matchMedia("(prefers-color-scheme: dark)");
    systemMedia.addEventListener("change", onSystemThemeChange);
  }
}

activateTheme(readStoredTheme());
