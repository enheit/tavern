import type { ClientMessage, ErrorCode, ServerMessage, StreamInfo } from "@tavern/shared";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { getVoiceController } from "@/features/voice/voiceController";
import type { StreamAudioSink } from "@/features/voice/voiceController";
import { ApiError, apiClient } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import {
  clearWatchPullState,
  clearWatchVideoStats,
  setWatchPullState,
  setWatchVideoStats,
} from "@/lib/testHooks";
import { connectRoom } from "@/lib/wsClient";
import { browserRtcPort } from "@/media/ports";
import { m } from "@/paraglide/messages.js";
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
  // Inbound-video getStats (framesDecoded/frameHeight) — surfaced to the §10 @realtime hook. Optional so
  // a test double may omit it; the real PullSession implements it.
  inboundVideoStats?(): Promise<{ framesDecoded: number; frameHeight: number | null }>;
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
    // §10 e2e hook (S8.5, FR-30): mirror this watch's dedicated PullSession state under its trackName so
    // streams.spec can assert `__tavernTestRtc.pullStates[trackName]`. `watching` = the pull is live
    // ('connected'); idle deletes the key (a never-watched or stopped tile reads `undefined`). No-op
    // outside the harness (the setters gate on platform.isE2E).
    if (s === "idle") clearWatchPullState(this.stream.trackName);
    else setWatchPullState(this.stream.trackName, s === "watching" ? "connected" : "connecting");
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
    this.unsubRemoved = ws.on("stream.removed", (msg) => {
      if (msg.trackName === this.stream.trackName) this.unwatch();
    });
    this.unsubError = ws.on("error", (msg) => {
      if (
        this.stateValue === "connecting" &&
        (msg.code === "pull_denied" || msg.code === "cost_cap")
      )
        this.failGrant(msg.code);
    });
    void this.startPull(serverId);
  }

  private async startPull(serverId: string): Promise<void> {
    const pull = this.deps.createPull(serverId);
    this.pull = pull;
    this.unsubTrack = pull.onTrack((tn, track) => this.onPulledTrack(tn, track));
    // §10 @realtime hook: expose this watch pull's inbound-video getStats by trackName (FR-27/32/33).
    setWatchVideoStats(
      this.stream.trackName,
      () => pull.inboundVideoStats?.() ?? Promise.resolve({ framesDecoded: 0, frameHeight: null }),
    );
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
    // §9.5: surface the typed code as an i18n-mapped toast, then return to idle. cost_cap gets the
    // S12.3-pinned kill-switch copy (§8 G5: budget reached, watching pauses until next month).
    toast.error(code === "cost_cap" ? m.cost_cap_toast() : errorMessage(code));
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
    clearWatchVideoStats(this.stream.trackName);
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

// Per-stream WatchController registry (keyed by trackName — unique per user/share, and one Canvas is a
// single server). The controller is NOT tied to a tile's React lifetime: FR-33 focus re-parents the
// tile (grid ↔ focus mode), which React implements as an unmount + remount into a different subtree.
// If the controller lived in the component, that remount would tear down and re-create the pull — a
// re-pull the design forbids ("double-click reacts by setLayer, no re-pull"). Keeping it here lets the
// remounted tile reuse the SAME live pull; teardown is deferred one task so a synchronous remount keeps
// it alive, while a genuine unmount (stream removed, navigation) still frees it (G1).
interface WatchEntry {
  controller: WatchController;
  mounts: number;
  teardown: ReturnType<typeof setTimeout> | null;
}
const watchRegistry = new Map<string, WatchEntry>();

// Non-reactive read of a stream's live watch state — used by the `f` fullscreen key to target the first
// stream that is actually showing video (a watched remote) rather than an unwatched placeholder. Safe as
// an on-demand keypress read of the module registry (no subscription needed).
export function isWatchingTrack(trackName: string): boolean {
  const entry = watchRegistry.get(trackName);
  return entry !== undefined && entry.controller.state !== "idle";
}

// Test seam: clears the module registry between unit tests (the deferred teardown is timer-based).
export function resetWatchRegistry(): void {
  for (const entry of watchRegistry.values()) {
    if (entry.teardown) clearTimeout(entry.teardown);
  }
  watchRegistry.clear();
}

// FR-30 tile seam: opt-in watch of a single stream. A never-watched tile still creates zero
// PullSessions (watch() is user-initiated); a watched pull survives the tile's focus remount and is
// freed one task after the last tile for the stream unmounts.
export function useWatch(stream: StreamInfo): {
  state: WatchState;
  mediaStream: MediaStream | null;
  watch(): void;
  unwatch(): void;
  setLayer(rid: "h" | "l"): void;
} {
  const key = stream.trackName;
  const entryRef = useRef<WatchEntry | null>(null);
  if (entryRef.current === null) {
    const existing = watchRegistry.get(key);
    if (existing !== undefined) {
      entryRef.current = existing;
    } else {
      const created: WatchEntry = {
        controller: new WatchController(stream, defaultWatchDeps()),
        mounts: 0,
        teardown: null,
      };
      watchRegistry.set(key, created);
      entryRef.current = created;
    }
  }
  const entry = entryRef.current;
  const controller = entry.controller;

  const subscribe = useCallback((cb: () => void) => controller.subscribe(cb), [controller]);
  const state = useSyncExternalStore(subscribe, () => controller.state);
  const mediaStream = useSyncExternalStore(subscribe, () => controller.mediaStream);

  useEffect(() => {
    entry.mounts += 1;
    if (entry.teardown) {
      clearTimeout(entry.teardown);
      entry.teardown = null;
    }
    return () => {
      entry.mounts -= 1;
      // Defer one task: a focus re-parent unmounts then remounts in the same commit, so `mounts` is
      // back to 1 by the time this fires and the pull is kept. The identity guard avoids tearing down a
      // newer controller that reused this trackName.
      entry.teardown = setTimeout(() => {
        if (entry.mounts === 0 && watchRegistry.get(key) === entry) {
          controller.unwatch();
          watchRegistry.delete(key);
        }
      }, 0);
    };
  }, [entry, controller, key]);

  const watch = useCallback(() => controller.watch(), [controller]);
  const unwatch = useCallback(() => controller.unwatch(), [controller]);
  const setLayer = useCallback((rid: "h" | "l") => controller.setLayer(rid), [controller]);

  return { state, mediaStream, watch, unwatch, setLayer };
}
