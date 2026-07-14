import type { ClientMessage } from "@tavern/shared";
import { create } from "zustand";
import { connectRoom } from "@/lib/wsClient";
import { getCam } from "@/media/capture";
import { getVoiceController } from "@/features/voice/voiceController";
import { useMediaStore } from "@/stores/media";
import { useSettingsStore } from "@/stores/settings";
import { startStreamPreview, type StreamPreviewPublication } from "./streamPreviewPublisher";

// The shared publishPC surface the webcam needs (§7.1: mic + screen + cam share ONE publish session,
// owned by the voiceController). PublishSession OWNS the `cam:{userId}` name + the webcam h/i/l
// encodings — useWebcam passes NO name/encodings. `camSender()` backs the mid-publish device switch.
export interface CamPublisher {
  publishCam(track: MediaStreamTrack): Promise<{ trackName: string; previewId?: string }>;
  unpublish(trackNames: string[]): Promise<void>;
  camSender(): RTCRtpSender | null;
}

interface WsSend {
  send(msg: ClientMessage): void;
}

export interface WebcamDeps {
  getCam(deviceId?: string): Promise<MediaStreamTrack>;
  publisher(): CamPublisher | null;
  wsFor(serverId: string): WsSend;
  activeServerId(): string | null;
  cameraDeviceId(): string | undefined;
  preview?(serverId: string, previewId: string, track: MediaStreamTrack): StreamPreviewPublication;
}

// Self-preview state (§App-D webcam tile): the live LOCAL webcam mirrored for the sharer's own tile.
// Canvas renders `stream` directly on the `cam:{userId}` tile — never a PullSession to self (FR-29).
// `active` drives the ControlsBar cam toggle. Kept out of stores/media.ts so this feature is self-
// contained; Canvas + ControlsBar read it here.
interface WebcamStoreState {
  active: boolean;
  trackName: string | null;
  stream: MediaStream | null;
  set: (next: { active: boolean; trackName: string | null; stream: MediaStream | null }) => void;
}

export const useWebcamStore = create<WebcamStoreState>((set) => ({
  active: false,
  trackName: null,
  stream: null,
  set: (next) => set(next),
}));

// jsdom (unit tests) has no MediaStream constructor; the guard degrades to a null self-preview there
// rather than throwing (the self-preview render is covered by StreamTile.test with a stream double).
// In the browser this always wraps the local webcam track for the sharer's own tile.
function wrapStream(track: MediaStreamTrack): MediaStream | null {
  return typeof MediaStream === "undefined" ? null : new MediaStream([track]);
}

// Non-React orchestrator: ONE webcam per user (PLAN §7.1 — `cam:{userId}` has no counter, so a second
// start while active is a no-op). Publishes on the voiceController's shared publishPC, mirrors the
// local track for the self-preview tile, and wires both stop paths (the track "ended" event + the
// ControlsBar toggle) → stream.stop.
export class WebcamController {
  private readonly deps: WebcamDeps;
  private serverId: string | null = null;
  private video: MediaStreamTrack | null = null;
  private stream: MediaStream | null = null;
  private trackName: string | null = null;
  private preview: StreamPreviewPublication | null = null;
  private starting = false;
  private stopping = false;

  constructor(deps: WebcamDeps) {
    this.deps = deps;
  }

  get active(): boolean {
    return this.trackName !== null;
  }

  async start(): Promise<void> {
    // Single webcam per user (§7.1): already publishing (or mid-start) → no-op.
    if (this.trackName !== null || this.starting) return;
    this.starting = true;
    try {
      const serverId = this.deps.activeServerId();
      if (serverId === null) throw new Error("webcam requires an active voice server");
      const publisher = this.deps.publisher();
      if (publisher === null) throw new Error("no publish session");
      const track = await this.deps.getCam(this.deps.cameraDeviceId());
      let name: { trackName: string; previewId?: string };
      try {
        name = await publisher.publishCam(track);
      } catch (err) {
        // Publish failed — release the camera and leave the state idle.
        track.stop();
        throw err;
      }
      this.serverId = serverId;
      this.video = track;
      this.stream = wrapStream(track);
      this.trackName = name.trackName;
      if (name.previewId !== undefined) {
        this.preview = this.deps.preview?.(serverId, name.previewId, track) ?? null;
      }
      // OS/browser "stop" or a device disappearing ends the capture track → stop the webcam (once).
      track.addEventListener("ended", () => void this.stop(), { once: true });
      useWebcamStore
        .getState()
        .set({ active: true, trackName: name.trackName, stream: this.stream });
      // `cam:{userId}` matches the cam's real dimensions; the App-D bitrate caps live in the engine's
      // WEBCAM_PRESET/WEBCAM_LOW encodings, not in this id (there is no `cam*` PresetId — §7.1/App-D).
      this.deps
        .wsFor(serverId)
        .send({ t: "stream.start", kind: "webcam", trackName: name.trackName, preset: "720p30" });
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    const trackName = this.trackName;
    if (trackName === null || this.stopping) return;
    this.stopping = true;
    const serverId = this.serverId;
    this.preview?.stop();
    this.preview = null;
    try {
      if (serverId !== null) this.deps.wsFor(serverId).send({ t: "stream.stop", trackName });
      await this.deps.publisher()?.unpublish([trackName]);
    } finally {
      this.video?.stop();
      this.video = null;
      this.stream = null;
      this.trackName = null;
      this.serverId = null;
      this.stopping = false;
      useWebcamStore.getState().set({ active: false, trackName: null, stream: null });
    }
  }

  // FR-29 device switch: the FR-22 mic pattern applied to the camera — stop the current track,
  // re-acquire on the new device, `replaceTrack` on the existing sender. The call never renegotiates
  // (replaceTrack keeps the App-D simulcast encodings). No-op when not publishing (the next start
  // picks up the newly-persisted deviceId).
  async switchDevice(deviceId?: string): Promise<void> {
    if (this.trackName === null) return;
    const sender = this.deps.publisher()?.camSender() ?? null;
    if (sender === null || this.video === null) return;
    this.video.stop();
    const next = await this.deps.getCam(deviceId);
    await sender.replaceTrack(next);
    this.video = next;
    this.stream = wrapStream(next);
    this.preview?.replaceTrack(next);
    useWebcamStore.getState().set({ active: true, trackName: this.trackName, stream: this.stream });
  }
}

function defaultDeps(): WebcamDeps {
  return {
    getCam,
    publisher: () => getVoiceController().webcamPublisher(),
    wsFor: (serverId) => connectRoom(serverId),
    // A webcam requires being in voice (it publishes on the voice publishPC) — the active voice server,
    // the same seam useScreenShare reads.
    activeServerId: () => useMediaStore.getState().inVoiceServerId,
    cameraDeviceId: () => useSettingsStore.getState().deviceSettings.cameraDeviceId,
    preview: startStreamPreview,
  };
}

let controller: WebcamController | null = null;

// App-wide singleton wired to the real capture/publish/ws seams. Tests construct WebcamController
// directly with fakes and never touch this.
export function getWebcamController(): WebcamController {
  controller ??= new WebcamController(defaultDeps());
  return controller;
}

// FR-29 hook seam for the ControlsBar: the live webcam-active flag (mirrored from useWebcamStore) +
// the start/stop actions. No serverId argument — the webcam always targets the active voice server.
export function useWebcam(): {
  active: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const active = useWebcamStore((s) => s.active);
  return {
    active,
    start: () => getWebcamController().start(),
    stop: () => getWebcamController().stop(),
  };
}
