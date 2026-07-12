import { z } from "zod";

// The window.tavern contract (PLAN §6.3). Desktop-only surface; the renderer-side PlatformBridge
// (S4.3) wraps this and adds kind:'desktop'|'web' — that name is NOT defined here.

export const platformSchema = z.enum(["win32", "darwin", "linux"]);

// Chromium system-loopback input-device ids (media/audio/audio_device_description.cc). Electron's
// display-media handler forwards the callback's audio string verbatim as the Chromium device id
// (electron_browser_context.cc), so ids beyond the documented 'loopback'|'loopbackWithMute' union
// are usable. "loopbackWithoutChrome" = system audio minus this app's own output, so Tavern voices
// and the soundboard no longer echo into the stream (FR-28). Per-OS backing: Windows WASAPI process
// loopback with EXCLUDE_TARGET_PROCESS_TREE (audio_low_latency_input_win.cc); macOS CoreAudio tap
// excluding the audio service's process objects (catap_audio_input_stream.mm, 14.2+) or the SCK
// stream's setExcludesCurrentProcessAudio (audio_loopback_input_mac_impl.mm, 13+) — both fail OPEN
// (plain full loopback) if exclusion can't be resolved.
export type LoopbackDevice = "loopback" | "loopbackWithoutChrome";

// AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK needs Windows build 20348+ (Win11 / Server 2022);
// consumer Win10 tops out at 19045, where only endpoint loopback exists (self-audio caveat stands).
const WIN_PROCESS_LOOPBACK_MIN_BUILD = 20348;

// Picks the loopback device for the display-media handler. `osVersion` is the dotted OS version
// ("10.0.26100" — os.release() in main, process.getSystemVersion() in preload); only the Windows
// build number is consulted (every macOS that can loopback at all — 13+ — can also exclude).
// Shared so main (capture) and preload (the static loopbackSelfAudioExcluded flag) cannot drift.
export function loopbackAudioDevice(platform: string, osVersion: string): LoopbackDevice | null {
  switch (platform) {
    case "win32": {
      const build = Number(osVersion.split(".")[2]);
      return build >= WIN_PROCESS_LOOPBACK_MIN_BUILD ? "loopbackWithoutChrome" : "loopback";
    }
    case "darwin":
      return "loopbackWithoutChrome";
    default:
      // linux is loopback-only behind a validated PipeWire flag path (S8.1); none until then.
      return null;
  }
}

export const ScreenSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  thumbnailDataUrl: z.string(),
  appIcon: z.string().optional(),
});
export type ScreenSource = z.infer<typeof ScreenSourceSchema>;

// macOS TCC Screen Recording state (systemPreferences.getMediaAccessStatus("screen") values).
// Anything but "granted" means desktopCapturer enumerates no screens (ScreenCaptureKit gates the
// list itself on macOS 14.4+), so the picker must route the user to System Settings instead of
// showing an empty grid. win32/linux have no such gate and always report "granted".
export const screenAccessStatusSchema = z.enum([
  "not-determined",
  "granted",
  "denied",
  "restricted",
  "unknown",
]);
export type ScreenAccessStatus = z.infer<typeof screenAccessStatusSchema>;

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
  // Static like `platform`/`isE2E` — computed once at preload load from loopbackAudioDevice(), no
  // new invoke channel on the frozen S4.1 surface. True when the OS loopback device excludes
  // Tavern's own audio (Windows 20348+ / macOS), i.e. the FR-28 self-audio caveat is moot.
  loopbackSelfAudioExcluded: boolean;
  secrets: { getToken(): Promise<string | null>; setToken(t: string | null): Promise<void> };
  capture: {
    getScreenSources(): Promise<ScreenSource[]>;
    selectSource(id: string | null): Promise<void>;
    loopbackAudioSupported(): Promise<boolean>;
    screenAccessStatus(): Promise<ScreenAccessStatus>;
    // macOS: deep-links System Settings → Privacy & Security → Screen Recording; no-op elsewhere.
    openScreenRecordingSettings(): Promise<void>;
    // FR-28 Linux stream audio: loads a pulse `module-remap-source` clone of the default sink's
    // monitor (descriptions carry "Monitor" so the renderer's fallback heuristic finds it) —
    // Chromium refuses to enumerate raw monitors (audio_manager_pulse.cc), a remap IS enumerated.
    // Resolves false off Linux / when pactl is unavailable. Release is idempotent.
    prepareStreamAudio(): Promise<boolean>;
    releaseStreamAudio(): Promise<void>;
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
