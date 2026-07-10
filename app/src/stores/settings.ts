import type { Locale, Theme, VolumesV1 } from "@tavern/shared";
import { VolumesV1 as VolumesV1Schema } from "@tavern/shared";
import { create } from "zustand";
import { getLocale, setLocale as setParaglideLocale } from "@/paraglide/runtime.js";
import { applyThemeClass, readStoredTheme, THEME_STORAGE_KEY } from "@/theme-boot";

// Local volume/mute state (§5.4 VolumesV1) persisted under this exact localStorage key.
export const VOLUMES_STORAGE_KEY = "settings.volumes.v1";

function defaultVolumes(): VolumesV1 {
  return { v: 1, users: {}, streams: {}, soundboard: 1, mutedUsers: [] };
}

function loadVolumes(): VolumesV1 {
  try {
    const raw = localStorage.getItem(VOLUMES_STORAGE_KEY);
    if (!raw) return defaultVolumes();
    const parsed = VolumesV1Schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : defaultVolumes();
  } catch {
    // localStorage unavailable or corrupt — fall back to defaults.
    return defaultVolumes();
  }
}

function persistVolumes(volumes: VolumesV1): void {
  try {
    localStorage.setItem(VOLUMES_STORAGE_KEY, JSON.stringify(volumes));
  } catch {
    // localStorage unavailable (privacy mode) — kept in memory this session.
  }
}

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
  // FR-16 notification prefs — local mirror of the server-side user_settings row.
  notifyAll: boolean;
  notifyMentions: boolean;
  // FR-20/31/38 local volumes + mutes (persisted, §5.4).
  volumes: VolumesV1;
  setTheme: (theme: Theme) => void;
  setLocale: (locale: Locale) => void;
  setNotifyAll: (notifyAll: boolean) => void;
  setNotifyMentions: (notifyMentions: boolean) => void;
  setVolumes: (volumes: VolumesV1) => void;
};

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: readStoredTheme(),
  locale: getLocale(),
  localeVersion: 0,
  notifyAll: true,
  notifyMentions: true,
  volumes: loadVolumes(),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  setLocale: (locale) => {
    setParaglideLocale(locale, { reload: false });
    set((state) => ({ locale, localeVersion: state.localeVersion + 1 }));
  },
  setNotifyAll: (notifyAll) => set({ notifyAll }),
  setNotifyMentions: (notifyMentions) => set({ notifyMentions }),
  setVolumes: (volumes) => {
    persistVolumes(volumes);
    set({ volumes });
  },
}));
