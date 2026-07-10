import type { ClientMessage, PresetId } from "@tavern/shared";
import { toast } from "sonner";
import { connectRoom } from "@/lib/wsClient";
import { captureScreen } from "@/media/capture";
import { m } from "@/paraglide/messages.js";
import { getVoiceController } from "@/features/voice/voiceController";
import { useMediaStore } from "@/stores/media";
import type { ShareSelection } from "./types";

// The shared publishPC surface screen share needs (§7.1: mic + screen + cam share ONE publish
// session, owned by the voiceController). PublishSession OWNS track naming + the per-share `n`
// counter and the App-D h/l encodings — useScreenShare passes NO names/kind and computes none.
export interface ScreenPublisher {
  publishStream(
    video: MediaStreamTrack,
    audio: MediaStreamTrack | null,
    preset: PresetId,
  ): Promise<{ videoTrackName: string; audioTrackName?: string }>;
  unpublish(trackNames: string[]): Promise<void>;
}

interface WsSend {
  send(msg: ClientMessage): void;
}

export interface ScreenShareDeps {
  capture(
    sel: ShareSelection,
  ): Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null }>;
  publisher(): ScreenPublisher | null;
  wsFor(serverId: string): WsSend;
  activeServerId(): string | null;
  caveat(): void;
}

const CAVEAT_FLAG = "tavern.selfAudioCaveatShown.v1";

// FR-28 pinned limitation: loopback captures ALL system audio (Tavern voices/soundboard leak into
// the stream). Shown once, the first time a share starts with audio, gated by a localStorage flag.
export function showSelfAudioCaveatOnce(): void {
  const store = typeof localStorage === "undefined" ? null : localStorage;
  if (store?.getItem(CAVEAT_FLAG) === "1") return;
  toast(m.streams_self_audio_caveat());
  store?.setItem(CAVEAT_FLAG, "1");
}

// Non-React orchestrator (single self-share at a time). Publishes on the voiceController's shared
// publishPC, mirrors the local publish state into stores/media.ts, and wires BOTH stop paths
// (OS/browser stop button via the track "ended" event + the ControlsBar toggle) → stream.stop.
export class ScreenShareController {
  private readonly deps: ScreenShareDeps;
  private serverId: string | null = null;
  private video: MediaStreamTrack | null = null;
  private audio: MediaStreamTrack | null = null;
  private videoTrackName: string | null = null;
  private audioTrackName: string | null = null;
  private stopping = false;

  constructor(deps: ScreenShareDeps) {
    this.deps = deps;
  }

  async start(sel: ShareSelection): Promise<void> {
    const serverId = this.deps.activeServerId();
    if (serverId === null) throw new Error("screen share requires an active voice server");
    const publisher = this.deps.publisher();
    if (publisher === null) throw new Error("no publish session");
    const { video, audio } = await this.deps.capture(sel);
    let names: { videoTrackName: string; audioTrackName?: string };
    try {
      names = await publisher.publishStream(video, audio, sel.preset);
    } catch (err) {
      // Publish failed — stop the captured tracks and leave the share state idle.
      video.stop();
      audio?.stop();
      throw err;
    }
    this.serverId = serverId;
    this.video = video;
    this.audio = audio;
    this.videoTrackName = names.videoTrackName;
    this.audioTrackName = names.audioTrackName ?? null;
    // The OS/browser "Stop sharing" button ends the capture track → stop the share (§7.1, once).
    video.addEventListener("ended", () => void this.stop(), { once: true });
    useMediaStore.getState().setShareState({
      sharing: true,
      sharePreset: sel.preset,
      shareTrackName: names.videoTrackName,
    });
    this.deps.wsFor(serverId).send(
      names.audioTrackName === undefined
        ? { t: "stream.start", kind: "screen", trackName: names.videoTrackName, preset: sel.preset }
        : {
            t: "stream.start",
            kind: "screen",
            trackName: names.videoTrackName,
            audioTrackName: names.audioTrackName,
            preset: sel.preset,
          },
    );
    if (this.audioTrackName !== null) this.deps.caveat();
  }

  async stop(): Promise<void> {
    const videoTrackName = this.videoTrackName;
    if (videoTrackName === null || this.stopping) return;
    this.stopping = true;
    const serverId = this.serverId;
    const names =
      this.audioTrackName === null ? [videoTrackName] : [videoTrackName, this.audioTrackName];
    try {
      if (serverId !== null)
        this.deps.wsFor(serverId).send({ t: "stream.stop", trackName: videoTrackName });
      await this.deps.publisher()?.unpublish(names);
    } finally {
      this.video?.stop();
      this.audio?.stop();
      this.video = null;
      this.audio = null;
      this.videoTrackName = null;
      this.audioTrackName = null;
      this.serverId = null;
      this.stopping = false;
      useMediaStore
        .getState()
        .setShareState({ sharing: false, sharePreset: null, shareTrackName: null });
    }
  }
}

function defaultDeps(): ScreenShareDeps {
  return {
    capture: captureScreen,
    publisher: () => getVoiceController().screenPublisher(),
    wsFor: (serverId) => connectRoom(serverId),
    activeServerId: () => useMediaStore.getState().inVoiceServerId,
    caveat: showSelfAudioCaveatOnce,
  };
}

let controller: ScreenShareController | null = null;

// App-wide singleton wired to the real capture/publish/ws seams. Tests construct
// ScreenShareController directly with fakes and never touch this.
export function getScreenShareController(): ScreenShareController {
  controller ??= new ScreenShareController(defaultDeps());
  return controller;
}

// FR-27 hook seam for the ControlsBar: the live share state (mirrored from stores/media.ts) + the
// start/stop actions. No serverId argument — the share always targets the active voice server.
export function useScreenShare(): {
  sharing: boolean;
  preset: PresetId | null;
  trackName: string | null;
  start(sel: ShareSelection): Promise<void>;
  stop(): Promise<void>;
} {
  const sharing = useMediaStore((s) => s.sharing);
  const preset = useMediaStore((s) => s.sharePreset);
  const trackName = useMediaStore((s) => s.shareTrackName);
  return {
    sharing,
    preset,
    trackName,
    start: (sel) => getScreenShareController().start(sel),
    stop: () => getScreenShareController().stop(),
  };
}
