import { desktopCapturer, session } from "electron";
import type { DesktopCapturerSource, Session } from "electron";
import { ScreenSourceSchema } from "@tavern/shared";
import type { ScreenSource } from "@tavern/shared";

// The source armed by capture:selectSource; consumed once by the display-media handler, then cleared.
let armedSourceId: string | null = null;

// Loopback (system/game audio) support per OS (FR-28). Initial matrix; S8.1 owns revisions.
export function loopbackAudioSupported(platform: NodeJS.Platform = process.platform): boolean {
  switch (platform) {
    case "win32":
      return true;
    case "darwin":
      return true;
    default:
      // linux is loopback-only behind a validated PipeWire flag path (S8.1); false until then.
      return false;
  }
}

export async function selectSource(id: string | null): Promise<void> {
  armedSourceId = id;
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

type DisplayMediaStreams = { video?: DesktopCapturerSource; audio?: "loopback" };

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
  if (loopbackAudioSupported()) {
    callback({ video: source, audio: "loopback" });
  } else {
    callback({ video: source });
  }
}

export function setupDisplayMediaHandler(target: Session = session.defaultSession): void {
  target.setDisplayMediaRequestHandler((_request, callback) => {
    void handleDisplayMediaRequest(callback);
  });
}
