import type { ClientMessage, PresetId } from "@tavern/shared";
import { toast } from "sonner";
import { ApiError } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { connectRoom } from "@/lib/wsClient";
import { captureScreen, SYSTEM_AUDIO_OFF } from "@/media/capture";
import type { ScreenCapture } from "@/media/capture";
import { m } from "@/paraglide/messages.js";
import { platform } from "@/platform/types";
import { getVoiceController } from "@/features/voice/voiceController";
import { useMediaStore } from "@/stores/media";
import { useSettingsStore } from "@/stores/settings";
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
  // FR-27 on-the-fly: fps-only applyConstraints + setParameters re-scaling both encodings from the
  // acquisition height (no renegotiation — publishSession.setPreset documents the S12.4 platform
  // pin). Owned by PublishSession; useScreenShare drives it then broadcasts stream.preset.
  setPreset(trackName: string, preset: PresetId): Promise<void>;
  unpublish(trackNames: string[]): Promise<void>;
}

interface WsSend {
  send(msg: ClientMessage): void;
}

export interface ScreenShareDeps {
  capture(sel: ShareSelection): Promise<ScreenCapture>;
  publisher(): ScreenPublisher | null;
  wsFor(serverId: string): WsSend;
  activeServerId(): string | null;
  notice(capture: ScreenCapture, wantedAudio: boolean): void;
}

const CAVEAT_FLAG = "tavern.selfAudioCaveatShown.v1";
const MONITOR_NOTE_FLAG = "tavern.systemAudioNoteShown.v1";

// jsdom (unit tests) has no MediaStream constructor; degrade to a null self-preview there rather than
// throwing. In the browser this wraps the local screen video track (video only — the tile is muted, so
// the share's system audio never needs to flow through the preview) for the sharer's own tile.
function wrapPreview(video: MediaStreamTrack): MediaStream | null {
  return typeof MediaStream === "undefined" ? null : new MediaStream([video]);
}

function toastOnce(flag: string, message: string): void {
  const store = typeof localStorage === "undefined" ? null : localStorage;
  if (store?.getItem(flag) === "1") return;
  toast(message);
  store?.setItem(flag, "1");
}

// FR-28 share-audio notices, keyed on where the audio track came from:
//  - "display" on a NON-tab surface = OS loopback (win/mac handler, or Windows-web system audio):
//    ALL system sound is in the stream, Tavern voices included — the classic caveat, shown once,
//    skipped where the loopback device already excludes Tavern ("loopbackWithoutChrome").
//  - "display" on a tab surface = tab audio only — nothing of Tavern's leaks; no notice.
//  - "monitor" = the web/Linux fallback: monitor capture with AEC self-exclusion — tell the user
//    once that system sound is on and call voices are filtered out.
//  - null while audio was wanted (web/Linux, fallback not "off") = nothing captured: hint where
//    the sound can come from. Shown per share — it flags an unmet expectation, not a fact of life.
export function showShareAudioNotice(capture: ScreenCapture, wantedAudio: boolean): void {
  if (capture.audioSource === "monitor") {
    toastOnce(MONITOR_NOTE_FLAG, m.streams_system_audio_note());
    return;
  }
  if (capture.audioSource === "display") {
    if (capture.tabAudio || platform.capture.loopbackSelfAudioExcluded) return;
    toastOnce(CAVEAT_FLAG, m.streams_self_audio_caveat());
    return;
  }
  const fallbackPlatform = platform.kind === "web" || platform.os === "linux";
  const pref = useSettingsStore.getState().deviceSettings.streamAudio;
  if (wantedAudio && fallbackPlatform && pref !== SYSTEM_AUDIO_OFF) {
    toast(m.streams_no_system_audio_hint());
  }
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
    // Desktop Linux FR-28: create the pulse remap-source the fallback will capture BEFORE the
    // capture enumerates devices. No-op false elsewhere; failure just means video-only + hint.
    if (sel.withAudio) await platform.capture.prepareStreamAudio();
    let capture: ScreenCapture;
    try {
      capture = await this.deps.capture(sel);
    } catch (err) {
      platform.capture.releaseStreamAudio();
      throw err;
    }
    const { video, audio } = capture;
    // The remap-source exists only to be captured — drop it right away when the fallback didn't
    // end up using it (display audio won, no device matched, or the user cancelled nothing).
    if (capture.audioSource !== "monitor") platform.capture.releaseStreamAudio();
    let names: { videoTrackName: string; audioTrackName?: string };
    try {
      names = await publisher.publishStream(video, audio, sel.preset);
    } catch (err) {
      // Publish failed — stop the captured tracks and leave the share state idle. A typed publish
      // rejection (G4 share_cap, G5 cost_cap, …) surfaces as an i18n toast (§9.5); a capture-cancel or
      // other non-ApiError rejection is not toasted (the user closed the picker themselves).
      video.stop();
      audio?.stop();
      platform.capture.releaseStreamAudio();
      if (err instanceof ApiError) toast.error(errorMessage(err.code));
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
    // FR-29: mirror the LOCAL video track so the sharer's own tile renders a live preview (Canvas
    // matches it by shareTrackName) instead of a black tile — the webcam self-preview pattern.
    useMediaStore.getState().setShareStream(wrapPreview(video));
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
    this.deps.notice(capture, sel.withAudio);
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
      // Idempotent, no-op off desktop Linux: tears down the share's pulse remap-source.
      platform.capture.releaseStreamAudio();
      this.video = null;
      this.audio = null;
      this.videoTrackName = null;
      this.audioTrackName = null;
      this.serverId = null;
      this.stopping = false;
      useMediaStore
        .getState()
        .setShareState({ sharing: false, sharePreset: null, shareTrackName: null });
      useMediaStore.getState().setShareStream(null);
    }
  }

  // FR-27 on-the-fly preset switch — no restart, no viewer renegotiation. Order (pinned): (a)+(b) the
  // engine's setPreset does an fps-only applyConstraints + sender.setParameters re-scaling both
  // encodings from the acquisition height (S12.4 pin in publishSession), then (c) the WS
  // `stream.preset` keeps the DO registry + cost meter (G5) accurate. A no-op when not sharing. The
  // store mirror updates only AFTER a successful local switch so the dropdown never lies.
  async setPreset(preset: PresetId): Promise<void> {
    const videoTrackName = this.videoTrackName;
    const serverId = this.serverId;
    if (videoTrackName === null || serverId === null) return;
    const publisher = this.deps.publisher();
    if (publisher === null) return;
    await publisher.setPreset(videoTrackName, preset);
    this.deps.wsFor(serverId).send({ t: "stream.preset", trackName: videoTrackName, preset });
    useMediaStore
      .getState()
      .setShareState({ sharing: true, sharePreset: preset, shareTrackName: videoTrackName });
  }
}

function defaultDeps(): ScreenShareDeps {
  return {
    capture: captureScreen,
    publisher: () => getVoiceController().screenPublisher(),
    wsFor: (serverId) => connectRoom(serverId),
    activeServerId: () => useMediaStore.getState().inVoiceServerId,
    notice: showShareAudioNotice,
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
  setPreset(preset: PresetId): Promise<void>;
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
    setPreset: (p) => getScreenShareController().setPreset(p),
  };
}
