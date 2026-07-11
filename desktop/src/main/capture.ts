import os from "node:os";
import { desktopCapturer, session, shell, systemPreferences } from "electron";
import type { DesktopCapturerSource, Session } from "electron";
import { ScreenSourceSchema, loopbackAudioDevice, screenAccessStatusSchema } from "@tavern/shared";
import type { LoopbackDevice, ScreenAccessStatus, ScreenSource } from "@tavern/shared";

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

// Resolves the armed desktopCapturer source with per-OS loopback audio (FR-28), then disarms.
// Unarmed / stale request → empty streams object (denial).
export async function handleDisplayMediaRequest(
  callback: (streams: DisplayMediaStreams) => void,
): Promise<void> {
  const targetId = armedSourceId;
  if (targetId === null) {
    callback({});
    return;
  }
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
  const source = sources.find((candidate) => candidate.id === targetId);
  armedSourceId = null;
  if (source === undefined) {
    callback({});
    return;
  }
  const audio = loopbackAudioDevice(process.platform, os.release());
  if (audio !== null) {
    callback({ video: source, audio });
  } else {
    callback({ video: source });
  }
}

export function setupDisplayMediaHandler(target: Session = session.defaultSession): void {
  target.setDisplayMediaRequestHandler((_request, callback) => {
    // Electron's d.ts narrows audio to 'loopback'|'loopbackWithMute', but the implementation
    // forwards any string as the Chromium input-device id (electron_browser_context.cc), which is
    // what lets "loopbackWithoutChrome" through. Widen at this one Electron boundary only.
    void handleDisplayMediaRequest(callback as (streams: DisplayMediaStreams) => void);
  });
}
