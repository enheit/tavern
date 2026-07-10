import type { ClientMessage, ErrorCode, ServerMessage, StreamInfo } from "@tavern/shared";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { getVoiceController } from "@/features/voice/voiceController";
import type { StreamAudioSink } from "@/features/voice/voiceController";
import { ApiError, apiClient } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { connectRoom } from "@/lib/wsClient";
import { browserRtcPort } from "@/media/ports";
import { PullSession } from "@/media/rtc/pullSession";
import { createSfuSignal } from "@/media/sfuSignal";
import { useServersStore } from "@/stores/servers";

// FR-30 watch lifecycle. `connecting` = watch.start sent + the dedicated PullSession is being
// created; `watching` = the pull is live (a video frame may still be in flight).
export type WatchState = "idle" | "connecting" | "watching";

// The dedicated per-watch PullSession surface (watchPC, §7.1) — one instance per watched stream,
// created on watch and closed on unwatch to isolate renegotiation churn (FR-30/33). The real
// S7.2 PullSession satisfies this structurally (no cast, §9.1).
interface PullLike {
  connect(): Promise<void>;
  onTrack(
    cb: (trackName: string, track: MediaStreamTrack, stream: MediaStream) => void,
  ): () => void;
  addRemoteTracks(tracks: Array<{ trackName: string; preferredRid?: "h" | "l" }>): Promise<void>;
  setLayer(trackName: string, rid: "h" | "l"): Promise<void>;
  close(): Promise<void>;
}

interface WsLike {
  send(msg: ClientMessage): void;
  on<T extends ServerMessage["t"]>(
    t: T,
    cb: (m: Extract<ServerMessage, { t: T }>) => void,
  ): () => void;
}

export interface WatchDeps {
  createPull(serverId: string): PullLike;
  wsFor(serverId: string): WsLike;
  sink(): StreamAudioSink | null;
  activeServerId(): string | null;
}

// Non-React orchestrator for ONE watched stream. Nothing is pulled until watch() (G1). The audio
// track routes into the shared AudioGraph via `streamKey = ${userId}:${kind}` (the same opaque key
// the volume slider uses); the video track is exposed as `mediaStream` for the tile's <video>.
export class WatchController {
  private readonly stream: StreamInfo;
  private readonly deps: WatchDeps;
  private stateValue: WatchState = "idle";
  private mediaStreamValue: MediaStream | null = null;
  private pull: PullLike | null = null;
  private serverId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubTrack: (() => void) | null = null;
  private unsubRemoved: (() => void) | null = null;
  private unsubError: (() => void) | null = null;

  constructor(stream: StreamInfo, deps: WatchDeps) {
    this.stream = stream;
    this.deps = deps;
  }

  get state(): WatchState {
    return this.stateValue;
  }

  get mediaStream(): MediaStream | null {
    return this.mediaStreamValue;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  private setState(s: WatchState): void {
    this.stateValue = s;
    this.notify();
  }

  // §5.4 / §7.3 opaque key: trackNames rotate per share, so audio + volume are keyed by the stable
  // (userId, kind) pair instead — it survives restarts and re-shares.
  private streamKey(): string {
    return `${this.stream.userId}:${this.stream.kind}`;
  }

  // The screen-audio companion track name, derived from the pinned §7.1 grammar
  // (screen:{uid}:{n} → screenAudio:{uid}:{n}). Only pulled when the stream advertises audio.
  private audioTrackName(): string {
    return this.stream.trackName.replace(/^screen:/, "screenAudio:");
  }

  watch(): void {
    if (this.stateValue !== "idle") return;
    const serverId = this.deps.activeServerId();
    if (serverId === null) return;
    this.serverId = serverId;
    this.setState("connecting");
    const ws = this.deps.wsFor(serverId);
    // watch.start grants the pull server-side (G1) + starts the watch-stat clock. There is no wire
    // ack (App-A has no watch.start response); a failed REST pull or an error frame reverts us.
    try {
      ws.send({ t: "watch.start", trackName: this.stream.trackName });
    } catch {
      // WS not open — abort the watch cleanly.
      this.finish();
      return;
    }
    this.unsubRemoved = ws.on("stream.removed", (m) => {
      if (m.trackName === this.stream.trackName) this.unwatch();
    });
    this.unsubError = ws.on("error", (m) => {
      if (this.stateValue === "connecting" && (m.code === "pull_denied" || m.code === "cost_cap"))
        this.failGrant(m.code);
    });
    void this.startPull(serverId);
  }

  private async startPull(serverId: string): Promise<void> {
    const pull = this.deps.createPull(serverId);
    this.pull = pull;
    this.unsubTrack = pull.onTrack((tn, track) => this.onPulledTrack(tn, track));
    // G3: grid tiles pin the low simulcast layer; audio (screen loopback) has no rid.
    const tracks: Array<{ trackName: string; preferredRid?: "h" | "l" }> = [
      { trackName: this.stream.trackName, preferredRid: "l" },
    ];
    if (this.stream.hasAudio) tracks.push({ trackName: this.audioTrackName() });
    try {
      await pull.connect();
      await pull.addRemoteTracks(tracks);
      if (this.stateValue === "connecting") this.setState("watching");
    } catch (err) {
      // A rejected REST pull (pull_denied / cost_cap / anything) reverts to idle.
      this.failGrant(err instanceof ApiError ? err.code : "pull_denied");
    }
  }

  private onPulledTrack(trackName: string, track: MediaStreamTrack): void {
    if (trackName === this.stream.trackName) {
      this.mediaStreamValue = new MediaStream([track]);
      this.notify();
    } else if (trackName === this.audioTrackName()) {
      // The muted <audio> flow-starter (crbug 40094084) is the graph's job, not ours.
      this.deps.sink()?.attachStreamAudio(this.streamKey(), new MediaStream([track]));
    }
  }

  private failGrant(code: ErrorCode): void {
    // §9.5: surface the typed code as an i18n-mapped toast, then return to idle.
    toast.error(errorMessage(code));
    this.finish();
  }

  unwatch(): void {
    if (this.stateValue === "idle") return;
    this.finish();
  }

  // FR-33: quality follows tile size — a focused tile pulls the high layer, a grid tile the low one.
  // tracks/update on the existing pull, no PC teardown.
  setLayer(rid: "h" | "l"): void {
    void this.pull?.setLayer(this.stream.trackName, rid);
  }

  // Shared teardown for unwatch() and grant failure: unsubscribe, detach audio, close the pull,
  // send watch.stop (stops the DO watch clock + grant), and revert to idle.
  private finish(): void {
    const serverId = this.serverId;
    this.unsubTrack?.();
    this.unsubRemoved?.();
    this.unsubError?.();
    this.unsubTrack = null;
    this.unsubRemoved = null;
    this.unsubError = null;
    this.deps.sink()?.detachStreamAudio(this.streamKey());
    void this.pull?.close();
    this.pull = null;
    this.mediaStreamValue = null;
    this.serverId = null;
    if (serverId !== null) {
      try {
        this.deps.wsFor(serverId).send({ t: "watch.stop", trackName: this.stream.trackName });
      } catch {
        // WS not open — the DO drops the grant on disconnect anyway.
      }
    }
    this.setState("idle");
  }
}

function defaultWatchDeps(): WatchDeps {
  const signal = createSfuSignal(apiClient);
  return {
    createPull: (serverId) => new PullSession({ rtc: browserRtcPort, signal, serverId }),
    wsFor: (serverId) => connectRoom(serverId),
    sink: () => getVoiceController().streamAudioSink(),
    activeServerId: () => useServersStore.getState().activeServerId,
  };
}

// FR-30 tile seam: opt-in watch of a single stream. The controller lives for the tile's lifetime
// (one per StreamTile) and is torn down on unmount — a never-watched tile creates zero PullSessions.
export function useWatch(stream: StreamInfo): {
  state: WatchState;
  mediaStream: MediaStream | null;
  watch(): void;
  unwatch(): void;
  setLayer(rid: "h" | "l"): void;
} {
  const ref = useRef<WatchController | null>(null);
  ref.current ??= new WatchController(stream, defaultWatchDeps());
  const controller = ref.current;

  const subscribe = useCallback((cb: () => void) => controller.subscribe(cb), [controller]);
  const state = useSyncExternalStore(subscribe, () => controller.state);
  const mediaStream = useSyncExternalStore(subscribe, () => controller.mediaStream);

  useEffect(
    () => () => {
      controller.unwatch();
    },
    [controller],
  );

  const watch = useCallback(() => controller.watch(), [controller]);
  const unwatch = useCallback(() => controller.unwatch(), [controller]);
  const setLayer = useCallback((rid: "h" | "l") => controller.setLayer(rid), [controller]);

  return { state, mediaStream, watch, unwatch, setLayer };
}
