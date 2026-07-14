import { RtcWatchDeliveryResponse } from "@tavern/shared";
import type {
  ClientMessage,
  ErrorCode,
  ScreenRid,
  ServerMessage,
  StreamInfo,
  WatchDelivery,
} from "@tavern/shared";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { getVoiceController } from "@/features/voice/voiceController";
import type { StreamAudioSink } from "@/features/voice/voiceController";
import { ApiError, apiClient } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { focusStore } from "@/lib/focusState";
import {
  clearWatchPullState,
  clearWatchVideoStats,
  setWatchPullState,
  setWatchVideoStats,
} from "@/lib/testHooks";
import { connectRoom } from "@/lib/wsClient";
import { browserRtcPort } from "@/media/ports";
import { startViewerQualityMonitor } from "@/media/qualityMonitor";
import { PullSession } from "@/media/rtc/pullSession";
import type { InboundVideoStats } from "@/media/rtc/pullSession";
import { createSfuSignal } from "@/media/sfuSignal";
import { m } from "@/paraglide/messages.js";
import { useServersStore } from "@/stores/servers";
import { useSettingsStore } from "@/stores/settings";

// A logical watch is independent from its current media-saving delivery. `audio` keeps the stream's
// audio companion and the server-side watch grant alive while closing only the remote video track.
export type WatchState = "idle" | "connecting" | "watching";
export type WatchMediaDelivery = "high" | "low" | "audio";

interface PullLike {
  connect(): Promise<void>;
  onTrack(
    cb: (trackName: string, track: MediaStreamTrack, stream: MediaStream) => void,
  ): () => void;
  addRemoteTracks(tracks: Array<{ trackName: string; preferredRid?: ScreenRid }>): Promise<void>;
  removeRemoteTracks(trackNames: string[]): Promise<void>;
  setLayer(trackName: string, rid: ScreenRid): Promise<void>;
  inboundVideoStats?(): Promise<InboundVideoStats>;
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
  joinVoice(serverId: string): Promise<void>;
  setDelivery(serverId: string, trackName: string, delivery: WatchDelivery): Promise<void>;
}

// Non-React orchestrator for one watched stream. Its lifetime is owned by the server-scoped registry
// below, not by a particular tile placement, so moving a tile between grid/focus/fullscreen never
// sends watch.stop or closes its PullSession.
export class WatchController {
  private stream: StreamInfo;
  private readonly deps: WatchDeps;
  private stateValue: WatchState = "idle";
  private mediaStreamValue: MediaStream | null = null;
  private deliveryValue: WatchMediaDelivery = "high";
  private deliveryTransitioningValue = false;
  private documentVisibleValue = true;
  private theaterVisibleValue = true;
  private pull: PullLike | null = null;
  private serverId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubTrack: (() => void) | null = null;
  private unsubRemoved: (() => void) | null = null;
  private unsubError: (() => void) | null = null;
  private unsubResnapshot: (() => void) | null = null;
  private watchStarted = false;
  private watchAttempt = 0;
  private stopQualityMonitor: (() => void) | null = null;
  private deliveryQueue: Promise<void> = Promise.resolve();
  private deliveryRevision = 0;

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

  get delivery(): WatchMediaDelivery {
    return this.deliveryValue;
  }

  get deliveryTransitioning(): boolean {
    return this.deliveryTransitioningValue;
  }

  updateStream(stream: StreamInfo): void {
    if (stream.trackName === this.stream.trackName) this.stream = stream;
  }

  setDocumentVisible(visible: boolean): void {
    if (this.documentVisibleValue === visible) return;
    this.documentVisibleValue = visible;
    this.requestDeliveryReconcile();
  }

  setTheaterVisible(visible: boolean): void {
    if (this.theaterVisibleValue === visible) return;
    this.theaterVisibleValue = visible;
    this.requestDeliveryReconcile();
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

  private setState(state: WatchState): void {
    this.stateValue = state;
    if (state === "idle") clearWatchPullState(this.stream.trackName);
    else
      setWatchPullState(this.stream.trackName, state === "watching" ? "connected" : "connecting");
    this.notify();
  }

  private streamKey(): string {
    return `${this.stream.userId}:${this.stream.kind}`;
  }

  private audioTrackName(): string {
    return this.stream.trackName.replace(/^screen:/, "screenAudio:");
  }

  private desiredDelivery(): WatchMediaDelivery {
    if (this.documentVisibleValue && this.theaterVisibleValue) return "high";
    return this.stream.hasAudio ? "audio" : "low";
  }

  async watch(): Promise<void> {
    if (this.stateValue !== "idle") return;
    const serverId = this.deps.activeServerId();
    if (serverId === null) return;
    const attempt = ++this.watchAttempt;
    this.serverId = serverId;
    this.deliveryValue = "high";
    this.setState("connecting");

    try {
      await this.deps.joinVoice(serverId);
    } catch (err) {
      console.warn("Joining voice before watching failed", err);
      if (this.watchAttempt === attempt) {
        this.finish();
        toast.error(m.voice_join_failed());
      }
      return;
    }
    if (this.watchAttempt !== attempt || this.state !== "connecting") return;

    const ws = this.deps.wsFor(serverId);
    try {
      ws.send({ t: "watch.start", trackName: this.stream.trackName });
      this.watchStarted = true;
    } catch (err) {
      console.warn("Sending watch.start failed", err);
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
      ) {
        this.failGrant(msg.code);
      }
    });
    // A hello.ok replaces the room snapshot after reconnect; the DO has already swept the old grant
    // and SFU session, so keeping this local pull would create a zombie watch.
    this.unsubResnapshot = ws.on("hello.ok", () => this.onResnapshot());
    void this.startPull(serverId);
  }

  private async startPull(serverId: string): Promise<void> {
    const pull = this.deps.createPull(serverId);
    this.pull = pull;
    this.unsubTrack = pull.onTrack((trackName, track) => this.onPulledTrack(trackName, track));
    setWatchVideoStats(
      this.stream.trackName,
      () =>
        pull.inboundVideoStats?.() ??
        Promise.resolve({
          framesDecoded: 0,
          frameHeight: null,
          bytesReceived: 0,
          framesPerSecond: null,
        }),
    );
    const tracks: Array<{ trackName: string; preferredRid?: ScreenRid }> = [
      { trackName: this.stream.trackName, preferredRid: "h" },
    ];
    if (this.stream.hasAudio) tracks.push({ trackName: this.audioTrackName() });
    try {
      await pull.connect();
      await pull.addRemoteTracks(tracks);
      if (this.pull !== pull || this.stateValue !== "connecting") return;
      this.startQualityMonitor(pull);
      this.setState("watching");
      this.requestDeliveryReconcile();
    } catch (err) {
      if (this.pull !== pull || this.stateValue !== "connecting") return;
      this.failGrant(err instanceof ApiError ? err.code : "pull_denied");
    }
  }

  private startQualityMonitor(pull: PullLike): void {
    if (this.stopQualityMonitor !== null) return;
    const readStats = pull.inboundVideoStats;
    if (readStats === undefined) return;
    this.stopQualityMonitor = startViewerQualityMonitor({
      trackName: this.stream.trackName,
      preset: () => this.stream.preset,
      streamKind: this.stream.kind,
      stats: () => readStats.call(pull),
    });
  }

  private stopVideoQualityMonitor(): void {
    this.stopQualityMonitor?.();
    this.stopQualityMonitor = null;
  }

  private onPulledTrack(trackName: string, track: MediaStreamTrack): void {
    if (trackName === this.stream.trackName) {
      this.mediaStreamValue = new MediaStream([track]);
      this.notify();
      return;
    }
    if (trackName !== this.audioTrackName()) return;
    const sink = this.deps.sink();
    if (sink === null) return;
    const key = this.streamKey();
    sink.attachStreamAudio(key, new MediaStream([track]));
    const level = useSettingsStore.getState().volumes.streams[key];
    if (level !== undefined) sink.setStreamVolume(key, level);
  }

  private requestDeliveryReconcile(): void {
    if (this.stateValue !== "watching") return;
    const revision = ++this.deliveryRevision;
    if (!this.deliveryTransitioningValue) {
      this.deliveryTransitioningValue = true;
      this.notify();
    }
    const operation = this.deliveryQueue.then(() => this.reconcileDelivery());
    this.deliveryQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.then(
      () => {
        if (revision !== this.deliveryRevision) return;
        this.deliveryTransitioningValue = false;
        this.notify();
      },
      (err: unknown) => {
        if (revision !== this.deliveryRevision || this.stateValue === "idle") return;
        console.error("Watch delivery transition failed", err);
        this.deliveryTransitioningValue = false;
        this.notify();
        toast.error(m.streams_delivery_failed());
      },
    );
  }

  private isCurrent(pull: PullLike, serverId: string): boolean {
    return this.pull === pull && this.serverId === serverId && this.stateValue === "watching";
  }

  private async reconcileDelivery(): Promise<void> {
    const pull = this.pull;
    const serverId = this.serverId;
    if (pull === null || serverId === null || this.stateValue !== "watching") return;
    const desired = this.desiredDelivery();
    const current = this.deliveryValue;
    if (desired === current) return;

    if (desired === "audio") {
      await pull.removeRemoteTracks([this.stream.trackName]);
      if (!this.isCurrent(pull, serverId)) return;
      try {
        await this.deps.setDelivery(serverId, this.stream.trackName, "audio");
      } catch (err) {
        // The server still considers this a video watch. Restore the exact prior video layer so local
        // media and durable accounting remain aligned before surfacing the failure.
        await pull.addRemoteTracks([
          { trackName: this.stream.trackName, preferredRid: current === "low" ? "l" : "h" },
        ]);
        throw err;
      }
      if (!this.isCurrent(pull, serverId)) return;
      this.stopVideoQualityMonitor();
      this.mediaStreamValue = null;
      this.deliveryValue = "audio";
      this.notify();
      return;
    }

    if (current === "audio") {
      await this.deps.setDelivery(serverId, this.stream.trackName, "video");
      if (!this.isCurrent(pull, serverId)) return;
      try {
        await pull.addRemoteTracks([
          { trackName: this.stream.trackName, preferredRid: desired === "low" ? "l" : "h" },
        ]);
      } catch (err) {
        try {
          await this.deps.setDelivery(serverId, this.stream.trackName, "audio");
        } catch (rollbackErr) {
          console.error("Video restore failed before delivery rollback also failed", err);
          throw new Error("Video restore and delivery rollback failed", { cause: rollbackErr });
        }
        throw err;
      }
      if (!this.isCurrent(pull, serverId)) return;
      this.deliveryValue = desired;
      this.startQualityMonitor(pull);
      this.notify();
      return;
    }

    await pull.setLayer(this.stream.trackName, desired === "low" ? "l" : "h");
    if (!this.isCurrent(pull, serverId)) return;
    this.deliveryValue = desired;
    this.notify();
  }

  private failGrant(code: ErrorCode): void {
    toast.error(code === "cost_cap" ? m.cost_cap_toast() : errorMessage(code));
    this.finish();
  }

  unwatch(): void {
    if (this.stateValue !== "idle") this.finish();
  }

  private onResnapshot(): void {
    if (this.stateValue !== "idle") this.finish();
  }

  setLayer(rid: ScreenRid): void {
    const operation = this.pull?.setLayer(this.stream.trackName, rid);
    if (operation !== undefined) {
      void operation.catch((err: unknown) => {
        console.error("Manual watch layer switch failed", err);
        toast.error(m.streams_delivery_failed());
      });
    }
  }

  private finish(): void {
    this.watchAttempt += 1;
    this.deliveryRevision += 1;
    const serverId = this.serverId;
    this.unsubTrack?.();
    this.unsubRemoved?.();
    this.unsubError?.();
    this.unsubResnapshot?.();
    this.unsubTrack = null;
    this.unsubRemoved = null;
    this.unsubError = null;
    this.unsubResnapshot = null;
    this.deps.sink()?.detachStreamAudio(this.streamKey());
    this.stopVideoQualityMonitor();
    clearWatchVideoStats(this.stream.trackName);
    const close = this.pull?.close();
    if (close !== undefined) {
      void close.catch((err: unknown) => console.warn("Closing watch PullSession failed", err));
    }
    this.pull = null;
    this.mediaStreamValue = null;
    this.serverId = null;
    this.deliveryValue = "high";
    this.deliveryTransitioningValue = false;
    if (serverId !== null && this.watchStarted) {
      try {
        this.deps.wsFor(serverId).send({ t: "watch.stop", trackName: this.stream.trackName });
      } catch (err) {
        // A disconnected socket cannot carry watch.stop; rtcCleanupFor owns the corresponding grant.
        console.warn("Sending watch.stop failed; relying on room disconnect cleanup", err);
      }
    }
    this.watchStarted = false;
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
    joinVoice: (serverId) => getVoiceController().join(serverId),
    setDelivery: async (serverId, trackName, delivery) => {
      await apiClient.put(`/api/rtc/${serverId}/watch/delivery`, RtcWatchDeliveryResponse, {
        trackName,
        delivery,
      });
    },
  };
}

interface WatchEntry {
  serverId: string;
  trackName: string;
  controller: WatchController;
}

const watchRegistry = new Map<string, WatchEntry>();
const theaterTrackByServer = new Map<string, string>();

function watchKey(serverId: string, trackName: string): string {
  return `${serverId}\u0000${trackName}`;
}

function theaterVisibleFor(serverId: string, trackName: string): boolean {
  const theaterTrack = theaterTrackByServer.get(serverId);
  return theaterTrack === undefined || theaterTrack === trackName;
}

function entryFor(serverId: string, stream: StreamInfo): WatchEntry {
  const key = watchKey(serverId, stream.trackName);
  const existing = watchRegistry.get(key);
  if (existing !== undefined) {
    existing.controller.updateStream(stream);
    return existing;
  }
  const controller = new WatchController(stream, defaultWatchDeps());
  controller.setDocumentVisible(focusStore.getState().visible);
  controller.setTheaterVisible(theaterVisibleFor(serverId, stream.trackName));
  const created = { serverId, trackName: stream.trackName, controller };
  watchRegistry.set(key, created);
  return created;
}

// Page visibility is reliable and preserves the two-monitor case: losing keyboard focus while Tavern
// remains visible does not change delivery. Hidden/minimized pages enter saver mode without polling.
focusStore.subscribe((state, previous) => {
  if (state.visible === previous.visible) return;
  for (const entry of watchRegistry.values()) {
    entry.controller.setDocumentVisible(state.visible);
  }
});

// Switching rooms/logging out is a real lifecycle boundary. Stop those sessions explicitly; tile
// reparenting and stream-tab layout changes never touch this path.
useServersStore.subscribe((state, previous) => {
  if (state.activeServerId === previous.activeServerId) return;
  for (const entry of watchRegistry.values()) {
    if (entry.serverId !== state.activeServerId) entry.controller.unwatch();
  }
});

export function setWatchTheaterFullscreen(serverId: string, trackName: string | null): void {
  if (trackName === null) theaterTrackByServer.delete(serverId);
  else theaterTrackByServer.set(serverId, trackName);
  for (const entry of watchRegistry.values()) {
    if (entry.serverId === serverId) {
      entry.controller.setTheaterVisible(trackName === null || entry.trackName === trackName);
    }
  }
}

export function isWatchingTrack(trackName: string): boolean {
  const serverId = useServersStore.getState().activeServerId;
  if (serverId === null) return false;
  return watchRegistry.get(watchKey(serverId, trackName))?.controller.state !== "idle";
}

export function resetWatchRegistry(): void {
  for (const entry of watchRegistry.values()) entry.controller.unwatch();
  watchRegistry.clear();
  theaterTrackByServer.clear();
}

export function useWatch(stream: StreamInfo): {
  state: WatchState;
  mediaStream: MediaStream | null;
  delivery: WatchMediaDelivery;
  deliveryTransitioning: boolean;
  watch(): void;
  unwatch(): void;
  setLayer(rid: ScreenRid): void;
} {
  const serverId = useServersStore((state) => state.activeServerId) ?? "";
  const entry = useMemo(() => entryFor(serverId, stream), [serverId, stream]);
  const controller = entry.controller;
  controller.updateStream(stream);

  const subscribe = useCallback((cb: () => void) => controller.subscribe(cb), [controller]);
  const state = useSyncExternalStore(subscribe, () => controller.state);
  const mediaStream = useSyncExternalStore(subscribe, () => controller.mediaStream);
  const delivery = useSyncExternalStore(subscribe, () => controller.delivery);
  const deliveryTransitioning = useSyncExternalStore(
    subscribe,
    () => controller.deliveryTransitioning,
  );

  const watch = useCallback(() => void controller.watch(), [controller]);
  const unwatch = useCallback(() => controller.unwatch(), [controller]);
  const setLayer = useCallback((rid: ScreenRid) => controller.setLayer(rid), [controller]);

  return { state, mediaStream, delivery, deliveryTransitioning, watch, unwatch, setLayer };
}
