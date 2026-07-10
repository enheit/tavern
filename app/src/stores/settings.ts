import type { Locale, Theme } from "@tavern/shared";
import { create } from "zustand";
import { getLocale, setLocale as setParaglideLocale } from "@/paraglide/runtime.js";
import { applyThemeClass, readStoredTheme, THEME_STORAGE_KEY } from "@/theme-boot";

// The `system` theme keeps tracking OS changes live; we hold the active MediaQueryList so
// switching away from `system` (or re-applying it) never leaks duplicate subscriptions.
let systemMedia: MediaQueryList | undefined;

function onSystemThemeChange(): void {
  applyThemeClass("system");
}

export function applyTheme(theme: Theme): void {
  applyThemeClass(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage may be unavailable (privacy mode) — the class is still applied this session.
  }
  if (systemMedia) {
    systemMedia.removeEventListener("change", onSystemThemeChange);
    systemMedia = undefined;
  }
  if (theme === "system" && typeof globalThis.matchMedia === "function") {
    systemMedia = globalThis.matchMedia("(prefers-color-scheme: dark)");
    systemMedia.addEventListener("change", onSystemThemeChange);
  }
}

type SettingsState = {
  theme: Theme;
  locale: Locale;
  // Bumped on every locale switch; the root component reads it as a React `key` to force a
  // full re-render so Paraglide's compiled messages pick up the new locale (§9.6).
  localeVersion: number;
  setTheme: (theme: Theme) => void;
  setLocale: (locale: Locale) => void;
};

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: readStoredTheme(),
  locale: getLocale(),
  localeVersion: 0,
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  setLocale: (locale) => {
    setParaglideLocale(locale, { reload: false });
    set((state) => ({ locale, localeVersion: state.localeVersion + 1 }));
  },
}));
