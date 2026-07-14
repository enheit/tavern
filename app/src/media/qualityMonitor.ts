import { QoeResponse, SCREEN_PRESETS, contentModeForPreset } from "@tavern/shared";
import type {
  PresetId,
  QoeHealth,
  QoeLimitation,
  QoeSample,
  ScreenRid,
  StreamContentMode,
} from "@tavern/shared";
import { create } from "zustand";
import { apiClient } from "@/lib/apiClient";
import { platform } from "@/platform/types";
import type { InboundVideoStats } from "./rtc/pullSession";
import type { OutboundVideoLayerStats } from "./rtc/publishSession";

const SAMPLE_INTERVAL_MS = 5_000;
const WARMUP_MS = 10_000;
const REPORT_INTERVAL_MS = 120_000;

export interface QualitySnapshot {
  role: "publisher" | "viewer";
  health: QoeHealth;
  limitation: QoeLimitation;
  contentMode: StreamContentMode;
  width: number | null;
  height: number | null;
  fps: number | null;
  targetFps: number;
  bitrateKbps: number | null;
  rid: ScreenRid | null;
  codec: string | null;
}

interface QualityState {
  snapshots: Record<string, QualitySnapshot>;
  setSnapshot(trackName: string, snapshot: QualitySnapshot): void;
  removeSnapshot(trackName: string): void;
}

export const useQualityStore = create<QualityState>((set) => ({
  snapshots: {},
  setSnapshot: (trackName, snapshot) =>
    set((state) => ({ snapshots: { ...state.snapshots, [trackName]: snapshot } })),
  removeSnapshot: (trackName) =>
    set((state) => {
      const snapshots = { ...state.snapshots };
      delete snapshots[trackName];
      return { snapshots };
    }),
}));

const videoElements = new Map<string, HTMLVideoElement>();

export function registerQualityVideoElement(
  trackName: string,
  element: HTMLVideoElement,
): () => void {
  videoElements.set(trackName, element);
  return () => {
    if (videoElements.get(trackName) === element) videoElements.delete(trackName);
  };
}

function delta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function rate(current: number, previous: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0) return null;
  return delta(current, previous) / (elapsedMs / 1_000);
}

function percent(part: number, total: number): number | null {
  return total <= 0 ? null : Math.min(100, Math.max(0, (part / total) * 100));
}

function roundMetric(value: number | null, digits = 1): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function ridOf(value: string | null): ScreenRid | null {
  return value === "h" || value === "i" || value === "l" ? value : null;
}

function classify(
  actualFps: number | null,
  targetFps: number,
  limitation: QoeLimitation,
  warming: boolean,
): QoeHealth {
  if (warming) return "adapting";
  if (limitation === "cpu" || limitation === "capture" || limitation === "decoder") {
    return "device_limited";
  }
  if (limitation === "bandwidth") return "network_limited";
  if (actualFps === null) return "adapting";
  const ratio = actualFps / targetFps;
  if (ratio >= 0.85) return "healthy";
  if (ratio >= 0.65) return "adapting";
  return "poor";
}

function publisherLimitation(
  reason: string | null,
  sourceFps: number | null,
  encodeFps: number | null,
  targetFps: number,
): QoeLimitation {
  if (reason === "bandwidth") return "bandwidth";
  if (reason === "cpu") return "cpu";
  if (sourceFps !== null && sourceFps < targetFps * 0.8) return "capture";
  if (encodeFps !== null && encodeFps < targetFps * 0.65) return "cpu";
  return reason === null || reason === "none" ? "none" : "unknown";
}

function viewerLimitation(input: {
  receiveFps: number | null;
  renderFps: number | null;
  lossPct: number | null;
  droppedPct: number | null;
  freezeMs: number | null;
}): QoeLimitation {
  if (
    (input.lossPct !== null && input.lossPct >= 3) ||
    (input.freezeMs !== null && input.freezeMs >= 500)
  ) {
    return "bandwidth";
  }
  if (
    (input.droppedPct !== null && input.droppedPct >= 5) ||
    (input.receiveFps !== null &&
      input.renderFps !== null &&
      input.renderFps < input.receiveFps * 0.75)
  ) {
    return "decoder";
  }
  return "none";
}

const latestTelemetry = new Map<string, QoeSample>();
const lastTelemetryHealth = new Map<string, QoeHealth>();
let reporter: ReturnType<typeof setInterval> | null = null;
const monitorIntervals = new Set<ReturnType<typeof setInterval>>();

function sampleHealthy(): boolean {
  const byte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
  return byte < 64;
}

async function flushTelemetry(): Promise<void> {
  const samples: QoeSample[] = [];
  for (const [key, sample] of latestTelemetry) {
    latestTelemetry.delete(key);
    if (sample.health === "healthy" && !sampleHealthy()) continue;
    samples.push(sample);
    if (samples.length === 32) break;
  }
  if (samples.length === 0) return;
  try {
    await apiClient.post("/api/qoe", QoeResponse, { v: 1, samples });
  } catch (err) {
    // Telemetry must never disrupt media, but failures remain observable during development.
    console.warn("QoE telemetry upload failed", err);
  }
}

function queueTelemetry(key: string, sample: QoeSample): void {
  const previousHealth = lastTelemetryHealth.get(key);
  lastTelemetryHealth.set(key, sample.health);
  latestTelemetry.set(key, sample);
  reporter ??= setInterval(() => void flushTelemetry(), REPORT_INTERVAL_MS);
  if (
    previousHealth !== undefined &&
    previousHealth !== sample.health &&
    sample.health !== "healthy"
  ) {
    void flushTelemetry();
  }
}

function stopReporterIfIdle(): void {
  if (reporter === null || monitorIntervals.size > 0 || latestTelemetry.size > 0) return;
  clearInterval(reporter);
  reporter = null;
}

function qoeBase(
  role: "publisher" | "viewer",
  preset: PresetId,
  streamKind: "screen" | "webcam",
): Pick<
  QoeSample,
  "role" | "platform" | "os" | "streamKind" | "contentMode" | "preset" | "targetFps"
> {
  return {
    role,
    platform: platform.kind,
    os: platform.os,
    streamKind,
    contentMode: contentModeForPreset(preset),
    preset,
    targetFps: SCREEN_PRESETS[preset].fps,
  };
}

export function startPublisherQualityMonitor(input: {
  trackName: string;
  track: MediaStreamTrack;
  preset: PresetId;
  stats(): Promise<OutboundVideoLayerStats[]>;
}): () => void {
  const startedAt = Date.now();
  let previousAt = startedAt;
  let previousFrames = 0;
  let previousBytes = 0;
  let busy = false;
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      const now = Date.now();
      const elapsedMs = now - previousAt;
      const layers = await input.stats();
      const high = layers.find((layer) => layer.rid === "h") ?? layers[0];
      if (high === undefined) return;
      const measuredEncodeFps =
        high.framesPerSecond ?? rate(high.framesEncoded, previousFrames, elapsedMs);
      const sourceSetting =
        typeof input.track.getSettings === "function"
          ? input.track.getSettings().frameRate
          : undefined;
      const sourceFps =
        high.sourceFramesPerSecond ??
        (typeof sourceSetting === "number" && sourceSetting > 0 ? sourceSetting : null);
      const bitrateKbps =
        elapsedMs <= 0 ? null : (delta(high.bytesSent, previousBytes) * 8) / elapsedMs;
      const targetFps = SCREEN_PRESETS[input.preset].fps;
      const limitation = publisherLimitation(
        high.qualityLimitationReason,
        sourceFps,
        measuredEncodeFps,
        targetFps,
      );
      const health = classify(
        measuredEncodeFps,
        targetFps,
        limitation,
        now - startedAt < WARMUP_MS,
      );
      const snapshot: QualitySnapshot = {
        role: "publisher",
        health,
        limitation,
        contentMode: contentModeForPreset(input.preset),
        width: high.frameWidth,
        height: high.frameHeight,
        fps: roundMetric(measuredEncodeFps),
        targetFps,
        bitrateKbps: roundMetric(bitrateKbps, 0),
        rid: ridOf(high.rid),
        codec: high.codec,
      };
      useQualityStore.getState().setSnapshot(input.trackName, snapshot);
      queueTelemetry(`publisher:${input.trackName}`, {
        ...qoeBase("publisher", input.preset, "screen"),
        codec: high.codec,
        rid: ridOf(high.rid),
        limitation,
        health,
        sourceFps: roundMetric(sourceFps),
        encodeFps: roundMetric(measuredEncodeFps),
        receiveFps: null,
        renderFps: null,
        width: high.frameWidth,
        height: high.frameHeight,
        bitrateKbps: roundMetric(bitrateKbps, 0),
        lossPct: null,
        rttMs: roundMetric(high.roundTripTime === null ? null : high.roundTripTime * 1_000),
        jitterMs: null,
        droppedPct: null,
        freezeMs: null,
        sampleWindowMs: Math.max(1_000, Math.min(300_000, elapsedMs)),
      });
      previousAt = now;
      previousFrames = high.framesEncoded;
      previousBytes = high.bytesSent;
    } catch (err) {
      console.warn("Publisher QoE sampling failed", err);
    } finally {
      busy = false;
    }
  };

  void poll();
  const interval = setInterval(() => void poll(), SAMPLE_INTERVAL_MS);
  monitorIntervals.add(interval);
  return () => {
    stopped = true;
    clearInterval(interval);
    monitorIntervals.delete(interval);
    latestTelemetry.delete(`publisher:${input.trackName}`);
    lastTelemetryHealth.delete(`publisher:${input.trackName}`);
    useQualityStore.getState().removeSnapshot(input.trackName);
    stopReporterIfIdle();
  };
}

export function startViewerQualityMonitor(input: {
  trackName: string;
  preset(): PresetId;
  streamKind: "screen" | "webcam";
  stats(): Promise<InboundVideoStats>;
}): () => void {
  const startedAt = Date.now();
  let previousAt = startedAt;
  let previousFramesDecoded = 0;
  let previousBytes = 0;
  let previousPacketsReceived = 0;
  let previousPacketsLost = 0;
  let previousFramesDropped = 0;
  let previousTotalVideoFrames = 0;
  let previousDroppedVideoFrames = 0;
  let previousFreezesDuration = 0;
  let busy = false;
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      const now = Date.now();
      const elapsedMs = now - previousAt;
      const preset = input.preset();
      const stats = await input.stats();
      const receiveFps =
        stats.framesPerSecond ?? rate(stats.framesDecoded, previousFramesDecoded, elapsedMs);
      const element = videoElements.get(input.trackName);
      const playback =
        element !== undefined && typeof element.getVideoPlaybackQuality === "function"
          ? element.getVideoPlaybackQuality()
          : undefined;
      const totalVideoFrames = playback?.totalVideoFrames ?? 0;
      const droppedVideoFrames = playback?.droppedVideoFrames ?? 0;
      const renderFps =
        playback === undefined
          ? receiveFps
          : rate(totalVideoFrames, previousTotalVideoFrames, elapsedMs);
      const droppedFrames =
        playback === undefined
          ? delta(stats.framesDropped, previousFramesDropped)
          : delta(droppedVideoFrames, previousDroppedVideoFrames);
      const renderedFrames =
        playback === undefined
          ? delta(stats.framesDecoded, previousFramesDecoded)
          : delta(totalVideoFrames, previousTotalVideoFrames);
      const droppedPct = percent(droppedFrames, renderedFrames + droppedFrames);
      const receivedPackets = delta(stats.packetsReceived, previousPacketsReceived);
      const lostPackets = delta(stats.packetsLost, previousPacketsLost);
      const lossPct = percent(lostPackets, receivedPackets + lostPackets);
      const freezeMs = delta(stats.totalFreezesDuration, previousFreezesDuration) * 1_000;
      const bitrateKbps =
        elapsedMs <= 0 ? null : (delta(stats.bytesReceived, previousBytes) * 8) / elapsedMs;
      const limitation = viewerLimitation({
        receiveFps,
        renderFps,
        lossPct,
        droppedPct,
        freezeMs,
      });
      const targetFps = SCREEN_PRESETS[preset].fps;
      const health = classify(renderFps, targetFps, limitation, now - startedAt < WARMUP_MS);
      const width = element?.videoWidth || stats.frameWidth;
      const height = element?.videoHeight || stats.frameHeight;
      const snapshot: QualitySnapshot = {
        role: "viewer",
        health,
        limitation,
        contentMode: contentModeForPreset(preset),
        width,
        height,
        fps: roundMetric(renderFps),
        targetFps,
        bitrateKbps: roundMetric(bitrateKbps, 0),
        rid: null,
        codec: stats.codec,
      };
      useQualityStore.getState().setSnapshot(input.trackName, snapshot);
      queueTelemetry(`viewer:${input.trackName}`, {
        ...qoeBase("viewer", preset, input.streamKind),
        codec: stats.codec,
        rid: null,
        limitation,
        health,
        sourceFps: null,
        encodeFps: null,
        receiveFps: roundMetric(receiveFps),
        renderFps: roundMetric(renderFps),
        width,
        height,
        bitrateKbps: roundMetric(bitrateKbps, 0),
        lossPct: roundMetric(lossPct),
        rttMs: roundMetric(stats.roundTripTime === null ? null : stats.roundTripTime * 1_000),
        jitterMs: roundMetric(stats.jitter === null ? null : stats.jitter * 1_000),
        droppedPct: roundMetric(droppedPct),
        freezeMs: roundMetric(freezeMs, 0),
        sampleWindowMs: Math.max(1_000, Math.min(300_000, elapsedMs)),
      });
      previousAt = now;
      previousFramesDecoded = stats.framesDecoded;
      previousBytes = stats.bytesReceived;
      previousPacketsReceived = stats.packetsReceived;
      previousPacketsLost = stats.packetsLost;
      previousFramesDropped = stats.framesDropped;
      previousTotalVideoFrames = totalVideoFrames;
      previousDroppedVideoFrames = droppedVideoFrames;
      previousFreezesDuration = stats.totalFreezesDuration;
    } catch (err) {
      console.warn("Viewer QoE sampling failed", err);
    } finally {
      busy = false;
    }
  };

  void poll();
  const interval = setInterval(() => void poll(), SAMPLE_INTERVAL_MS);
  monitorIntervals.add(interval);
  return () => {
    stopped = true;
    clearInterval(interval);
    monitorIntervals.delete(interval);
    latestTelemetry.delete(`viewer:${input.trackName}`);
    lastTelemetryHealth.delete(`viewer:${input.trackName}`);
    useQualityStore.getState().removeSnapshot(input.trackName);
    stopReporterIfIdle();
  };
}

export function resetQualityMonitoringForTests(): void {
  if (reporter !== null) clearInterval(reporter);
  reporter = null;
  for (const interval of monitorIntervals) clearInterval(interval);
  monitorIntervals.clear();
  latestTelemetry.clear();
  lastTelemetryHealth.clear();
  videoElements.clear();
  useQualityStore.setState({ snapshots: {} });
}
