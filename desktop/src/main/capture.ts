import { execFile } from "node:child_process";
import os from "node:os";
import { desktopCapturer, session, shell, systemPreferences } from "electron";
import type { DesktopCapturerSource, Session } from "electron";
import {
  ScreenSourceSchema,
  captureSourceMode,
  loopbackAudioDevice,
  screenAccessStatusSchema,
} from "@tavern/shared";
import type { LoopbackDevice, ScreenAccessStatus, ScreenSource } from "@tavern/shared";
import { prepareVenmic, releaseVenmic } from "./venmic";

// The source armed by capture:selectSource; consumed once by the display-media handler, then cleared.
let armedSourceId: string | null = null;

// Loopback (system/game audio) support per OS (FR-28) — true when loopbackAudioDevice picks any
// device for this OS. Initial matrix (win32/darwin yes, linux no); S8.1 owns revisions.
export function loopbackAudioSupported(platform: NodeJS.Platform = process.platform): boolean {
  return loopbackAudioDevice(platform, os.release()) !== null;
}

export async function selectSource(id: string | null): Promise<void> {
  armedSourceId = id;
}

// macOS gates screen enumeration behind the TCC Screen Recording permission (ScreenCaptureKit on
// 14.4+ returns NO screen sources without it — silently, no prompt from a bare list call). Surface
// the status so the picker can explain instead of rendering an empty grid. win32/linux: no gate.
export async function screenAccessStatus(
  platform: NodeJS.Platform = process.platform,
): Promise<ScreenAccessStatus> {
  if (platform !== "darwin") return "granted";
  return screenAccessStatusSchema.parse(systemPreferences.getMediaAccessStatus("screen"));
}

// Deep link to System Settings → Privacy & Security → Screen Recording (macOS only). The pane key
// is the pre-Ventura one — Ventura+ still resolves it to the new Settings app.
export async function openScreenRecordingSettings(
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "darwin") return;
  await shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  );
}

export async function getScreenSources(): Promise<ScreenSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((source) => {
    const base = {
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL(),
    };
    const appIcon = source.appIcon ? source.appIcon.toDataURL() : undefined;
    return ScreenSourceSchema.parse(appIcon === undefined ? base : { ...base, appIcon });
  });
}

type DisplayMediaStreams = { video?: DesktopCapturerSource; audio?: LoopbackDevice };

// Denial contract (electron_browser_context.cc DisplayMediaDeviceChosen): callback(null) is the
// ONLY clean rejection — the renderer's getDisplayMedia rejects and nothing throws. callback({})
// throws "Video was requested, but no video stream was provided" in the MAIN process (observed on
// 0.5.0 Wayland as an UnhandledPromiseRejectionWarning per share attempt).
type DisplayMediaCallback = (streams: DisplayMediaStreams | null) => void;

// Resolves the armed source with per-OS loopback audio (FR-28), then disarms. Unarmed / stale
// request → callback(null) (denial). Never throws: a rejected getSources (portal cancelled or
// broken — electron#47980) must still answer the callback or the renderer hangs forever.
export async function handleDisplayMediaRequest(
  callback: DisplayMediaCallback,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const targetId = armedSourceId;
  armedSourceId = null;
  if (targetId === null) {
    callback(null);
    return;
  }
  try {
    // Wayland: this getSources call IS the picker — it opens the OS portal dialog and resolves
    // with exactly the one source the user approved there (grid ids from any earlier enumeration
    // are already dead, so matching by id would always deny). X11/win/mac: ids are stable — find
    // the grid pick. thumbnailSize 0×0 skips thumbnail capture either way (only ids are needed).
    const portal = captureSourceMode(platform, env) === "portal";
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const source = portal ? sources[0] : sources.find((candidate) => candidate.id === targetId);
    if (source === undefined) {
      callback(null);
      return;
    }
    const audio = loopbackAudioDevice(process.platform, os.release());
    if (audio !== null) {
      callback({ video: source, audio });
    } else {
      callback({ video: source });
    }
  } catch (err) {
    console.warn("[capture] display-media request failed — denying", err);
    callback(null);
  }
}

export function setupDisplayMediaHandler(target: Session = session.defaultSession): void {
  target.setDisplayMediaRequestHandler((_request, callback) => {
    // Electron's d.ts narrows audio to 'loopback'|'loopbackWithMute' and the callback to non-null,
    // but the implementation forwards any audio string as the Chromium input-device id and treats
    // null as the documented denial (electron_browser_context.cc). Widen at this one boundary only.
    void handleDisplayMediaRequest(callback as DisplayMediaCallback);
  });
}

// ---------------------------------------------------------------------------------------------
// FR-28 Linux stream audio (system sound). Chromium's native loopback options are dead ends on
// Linux, both container-probed on Electron 43 + pulse: the display handler's 'loopback' device
// (behind PulseaudioLoopbackForScreenShare) delivers a track that IGNORES echoCancellation and
// 'loopbackWithoutChrome' falls open to full loopback — Tavern voices would echo into the stream.
// Raw "Monitor of …" sources are excluded from Chromium's input enumeration outright
// (audio_manager_pulse.cc). What DOES work: a `module-remap-source` clone of the default sink's
// monitor — a first-class source Chromium enumerates, captures via getUserMedia, and (probed)
// APM-cancels the app's own playout from when echoCancellation:true. So the main process loads
// the remap around each audio share; the renderer's fallback picks it up by its "Monitor" label.
// Works against PulseAudio and pipewire-pulse; missing pactl (rare) → false → video-only + hint.
const STREAM_AUDIO_SOURCE = "tavern_stream_audio";
const PACTL_TIMEOUT_MS = 3000;

function pactl(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("pactl", args, { timeout: PACTL_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

// Unloads every remap module owning our source name — covers the live one AND strays from a
// crashed previous run (loading a second module with the same source_name would fail anyway).
async function unloadStreamAudioModules(): Promise<void> {
  const modules = await pactl(["list", "short", "modules"]);
  if (modules === null) return;
  const ids = modules
    .split("\n")
    .filter((line) => line.includes(STREAM_AUDIO_SOURCE))
    .map((line) => line.split("\t")[0])
    .filter((id): id is string => id !== undefined && /^\d+$/.test(id));
  await Promise.all(ids.map((id) => pactl(["unload-module", id])));
}

export async function prepareStreamAudio(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== "linux") return false;
  // Task-3 layering: venmic first (PipeWire-native loopback, Tavern's own audio excluded by PID at
  // the source — no echo canceller in the content path). ANY venmic failure — no PipeWire, missing
  // optional module/prebuild, link error — falls through SILENTLY to the pactl remap below, which
  // stays the web path and the non-PipeWire fallback.
  if (await prepareVenmic({ platform })) return true;
  await unloadStreamAudioModules();
  const sink = (await pactl(["get-default-sink"]))?.trim();
  if (sink === undefined || sink.length === 0) return false;
  // device.description is what Chromium shows as the input label — the renderer's auto-pick
  // matches it exactly (and /monitor/i as a net). SPACELESS on purpose: pipewire-pulse's
  // remap-source module truncates quoted AND escaped multi-word descriptions at the first space
  // (probed on PipeWire 1.0.5 — "Tavern Stream …" became "Tavern"); one word survives every server.
  const loaded = await pactl([
    "load-module",
    "module-remap-source",
    `master=${sink}.monitor`,
    `source_name=${STREAM_AUDIO_SOURCE}`,
    "source_properties=device.description=TavernStreamMonitor",
  ]);
  if (loaded === null) return false;
  // Defensive volume reset, best-effort: any AGC-enabled capture (Chromium's own, another app's)
  // can leave the sink's MONITOR source dragged down and it persists — container-probed at 8% /
  // −66 dB, which would make the stream near-silent. Monitor volume feeds the remap, so both get
  // pinned to 100%/unmuted at creation.
  await Promise.all([
    pactl(["set-source-volume", `${sink}.monitor`, "100%"]),
    pactl(["set-source-mute", `${sink}.monitor`, "0"]),
    pactl(["set-source-volume", STREAM_AUDIO_SOURCE, "100%"]),
    pactl(["set-source-mute", STREAM_AUDIO_SOURCE, "0"]),
  ]);
  return true;
}

export async function releaseStreamAudio(
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "linux") return;
  releaseVenmic();
  await unloadStreamAudioModules();
}
