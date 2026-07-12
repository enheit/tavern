import type { Locale, Theme, VolumesV1 } from "@tavern/shared";
import { VolumesV1 as VolumesV1Schema } from "@tavern/shared";
import { create } from "zustand";
import { getLocale, setLocale as setParaglideLocale } from "@/paraglide/runtime.js";
import { applyThemeClass, readStoredTheme, THEME_STORAGE_KEY } from "@/theme-boot";

// Local volume/mute state (§5.4 VolumesV1) persisted under this exact localStorage key.
export const VOLUMES_STORAGE_KEY = "settings.volumes.v1";

// FR-21/22 device preferences (input/output device + noise suppression), persisted here — the
// device-prefs record, distinct from the volumes record. No shared zod schema exists for it, so it
// is validated structurally on read (§9.8 boundary parse without adding a shared/ schema).
export const DEVICE_SETTINGS_KEY = "tavern.settings.v1";

// FR-22 noise-suppression mode: "standard" = Chromium's built-in NS+AGC constraints; "deepfilter" =
// the DeepFilterNet3 WASM AudioWorklet model applied after capture, on-device (browser NS off so
// the model sees the raw signal); "off" = no suppression at all. AEC is always on regardless of
// mode. RNNoise was dropped — DeepFilterNet3 is the single AI model, tunable via `deepfilterAtten`.
export const NOISE_SUPPRESSION_MODES = ["off", "standard", "deepfilter"] as const;
export type NoiseSuppressionMode = (typeof NOISE_SUPPRESSION_MODES)[number];

export function isNoiseSuppressionMode(value: unknown): value is NoiseSuppressionMode {
  return (NOISE_SUPPRESSION_MODES as readonly unknown[]).includes(value);
}

// DeepFilterNet3 attenuation limit (dB), the model's one runtime knob — the max it may attenuate
// anything it classifies as noise. Higher = cleaner but clips quiet speech; lower = gentler. The
// package default is 50; we default lower so soft word-onsets survive (the "cutting out" fix).
export const DEEPFILTER_ATTEN_MIN = 0;
export const DEEPFILTER_ATTEN_MAX = 100;
export const DEEPFILTER_ATTEN_DEFAULT = 30;

function clampAtten(value: number): number {
  if (!Number.isFinite(value)) return DEEPFILTER_ATTEN_DEFAULT;
  return Math.max(DEEPFILTER_ATTEN_MIN, Math.min(DEEPFILTER_ATTEN_MAX, Math.round(value)));
}

// Pre-enum records persisted a boolean (the FR-22 on/off switch) — map it onto the enum. Since
// Task-2 the canonical "suppression on" is DeepFilterNet3 (deepfilter): legacy `true`, absent,
// invalid, and the retired "rnnoise" value all land there; an explicit stored mode is always kept.
// deepfilter degrades to the raw mic at RUNTIME when its assets fail to load (noiseWorklet fallback)
// — the setting itself never silently rewrites.
function parseNoiseSuppression(value: unknown): NoiseSuppressionMode {
  if (isNoiseSuppressionMode(value)) return value;
  if (value === false) return "off";
  return "deepfilter";
}

export interface DeviceSettingsV1 {
  micId?: string;
  sinkId?: string;
  // FR-29 selected webcam (videoinput deviceId); undefined = the browser default camera.
  cameraDeviceId?: string;
  noiseSuppression: NoiseSuppressionMode;
  // DeepFilterNet3 tunables, surfaced live in Voice settings so users can dial in what sounds best.
  // `deepfilterAtten` = the model's attenuation limit (dB, 0..100); undefined = DEEPFILTER_ATTEN_DEFAULT.
  // `autoGainControl` = the getUserMedia AGC constraint (applies to every mode); undefined = false
  // (Chromium's AGC pumps quiet-room gain between words — see media/capture.ts). Both only matter
  // for capture, so a stale value on a non-deepfilter mode is harmless.
  deepfilterAtten?: number;
  autoGainControl?: boolean;
  // FR-28 system-audio fallback source, used when a screen share resolves with no audio track of
  // its own (web/Linux — the browser offers audio for tab shares only there). "auto" (= undefined)
  // picks the first monitor-labeled input (PulseAudio/PipeWire "Monitor of …"); "off" disables the
  // fallback; any other value is an explicit audioinput deviceId — chosen in Voice settings, and an
  // explicit device is honored INSTEAD of display audio (the user picked the source).
  streamAudio?: string;
}

function defaultDeviceSettings(): DeviceSettingsV1 {
  return { noiseSuppression: "deepfilter" };
}

export function loadDeviceSettings(): DeviceSettingsV1 {
  try {
    const raw = localStorage.getItem(DEVICE_SETTINGS_KEY);
    if (!raw) return defaultDeviceSettings();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return defaultDeviceSettings();
    const rec = parsed as Record<string, unknown>;
    const next: DeviceSettingsV1 = {
      noiseSuppression: parseNoiseSuppression(rec.noiseSuppression),
    };
    if (typeof rec.micId === "string") next.micId = rec.micId;
    if (typeof rec.sinkId === "string") next.sinkId = rec.sinkId;
    if (typeof rec.cameraDeviceId === "string") next.cameraDeviceId = rec.cameraDeviceId;
    if (typeof rec.streamAudio === "string") next.streamAudio = rec.streamAudio;
    if (typeof rec.deepfilterAtten === "number")
      next.deepfilterAtten = clampAtten(rec.deepfilterAtten);
    if (typeof rec.autoGainControl === "boolean") next.autoGainControl = rec.autoGainControl;
    return next;
  } catch {
    // localStorage unavailable or corrupt — fall back to defaults.
    return defaultDeviceSettings();
  }
}

function persistDeviceSettings(settings: DeviceSettingsV1): void {
  try {
    localStorage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable (privacy mode) — kept in memory this session.
  }
}

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
  // FR-21/22 device prefs (persisted under DEVICE_SETTINGS_KEY).
  deviceSettings: DeviceSettingsV1;
  setTheme: (theme: Theme) => void;
  setLocale: (locale: Locale) => void;
  setNotifyAll: (notifyAll: boolean) => void;
  setNotifyMentions: (notifyMentions: boolean) => void;
  // FR-16: seed the notification prefs from the server row at boot (GET /api/me carries them) so a
  // user who disabled notifications on another device — or last session — is respected here instead
  // of silently reverting to the local defaults. Only the notify prefs are hydrated: theme/locale are
  // already applied pre-render from localStorage/Paraglide, and overwriting them here would fight
  // that path.
  hydrateNotifyPrefs: (prefs: { notifyAll: boolean; notifyMentions: boolean }) => void;
  setVolumes: (volumes: VolumesV1) => void;
  setDeviceSettings: (deviceSettings: DeviceSettingsV1) => void;
};

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: readStoredTheme(),
  locale: getLocale(),
  localeVersion: 0,
  notifyAll: true,
  notifyMentions: true,
  volumes: loadVolumes(),
  deviceSettings: loadDeviceSettings(),
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
  hydrateNotifyPrefs: ({ notifyAll, notifyMentions }) => set({ notifyAll, notifyMentions }),
  setVolumes: (volumes) => {
    persistVolumes(volumes);
    set({ volumes });
  },
  setDeviceSettings: (deviceSettings) => {
    persistDeviceSettings(deviceSettings);
    set({ deviceSettings });
  },
}));
