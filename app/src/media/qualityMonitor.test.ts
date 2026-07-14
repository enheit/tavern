import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundVideoStats } from "./rtc/pullSession";
import type { OutboundVideoLayerStats } from "./rtc/publishSession";

const api = vi.hoisted(() => ({ post: vi.fn(async () => ({ accepted: 1 })) }));
vi.mock("@/lib/apiClient", () => ({ apiClient: api }));
vi.mock("@/platform/types", () => ({ platform: { kind: "web", os: "web" } }));

import {
  registerQualityVideoElement,
  resetQualityMonitoringForTests,
  startPublisherQualityMonitor,
  startViewerQualityMonitor,
  useQualityStore,
} from "./qualityMonitor";

function outbound(
  framesEncoded: number,
  bytesSent: number,
  qualityLimitationReason: string | null = null,
): OutboundVideoLayerStats {
  return {
    rid: "h",
    frameWidth: 1920,
    frameHeight: 1080,
    framesEncoded,
    framesSent: framesEncoded,
    packetsSent: framesEncoded,
    bytesSent,
    framesPerSecond: null,
    sourceFramesPerSecond: null,
    targetBitrate: 3_500_000,
    qualityLimitationReason,
    totalEncodeTime: 1,
    codec: "VP8",
    roundTripTime: 0.05,
  };
}

function inbound(overrides: Partial<InboundVideoStats>): InboundVideoStats {
  return {
    framesDecoded: 0,
    framesReceived: 0,
    framesDropped: 0,
    frameWidth: 640,
    frameHeight: 360,
    packetsReceived: 0,
    packetsLost: 0,
    bytesReceived: 0,
    framesPerSecond: null,
    jitter: 0.01,
    freezeCount: 0,
    totalFreezesDuration: 0,
    totalDecodeTime: 1,
    codec: "VP9",
    roundTripTime: 0.04,
    ...overrides,
  };
}

async function settleImmediatePoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetQualityMonitoringForTests();
  api.post.mockReset();
  api.post.mockResolvedValue({ accepted: 1 });
});

afterEach(() => {
  resetQualityMonitoringForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("stream quality monitoring", () => {
  it("classifies publisher bandwidth pressure, reports its latest sample, and cleans up", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    api.post.mockRejectedValueOnce(new Error("telemetry offline"));
    const stats = vi
      .fn<() => Promise<OutboundVideoLayerStats[]>>()
      .mockResolvedValueOnce([outbound(0, 0)])
      .mockResolvedValueOnce([outbound(150, 500_000)])
      .mockResolvedValueOnce([outbound(300, 1_000_000, "bandwidth")])
      .mockRejectedValueOnce(new Error("stats unavailable"));
    const track = {
      getSettings: () => ({ frameRate: 30 }),
    } as unknown as MediaStreamTrack;

    const stop = startPublisherQualityMonitor({
      trackName: "screen:publisher:1",
      track,
      preset: "1080p30",
      stats,
    });
    await settleImmediatePoll();
    expect(useQualityStore.getState().snapshots["screen:publisher:1"]?.health).toBe("adapting");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(useQualityStore.getState().snapshots["screen:publisher:1"]).toEqual({
      role: "publisher",
      health: "network_limited",
      limitation: "bandwidth",
      contentMode: "balanced",
      width: 1920,
      height: 1080,
      fps: 30,
      targetFps: 30,
      bitrateKbps: 800,
      rid: "h",
      codec: "VP8",
    });
    expect(api.post).toHaveBeenCalledWith(
      "/api/qoe",
      expect.anything(),
      expect.objectContaining({
        v: 1,
        samples: [
          expect.objectContaining({
            role: "publisher",
            health: "network_limited",
            limitation: "bandwidth",
            sourceFps: 30,
            encodeFps: 30,
            bitrateKbps: 800,
            rttMs: 50,
            sampleWindowMs: 5000,
          }),
        ],
      }),
    );
    expect(warning).toHaveBeenCalledWith("QoE telemetry upload failed", expect.any(Error));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(warning).toHaveBeenCalledWith("Publisher QoE sampling failed", expect.any(Error));
    stop();
    expect(useQualityStore.getState().snapshots["screen:publisher:1"]).toBeUndefined();
  });

  it("distinguishes viewer decoder and network limits from playback and transport counters", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stats = vi
      .fn<() => Promise<InboundVideoStats>>()
      .mockResolvedValueOnce(inbound({}))
      .mockResolvedValueOnce(
        inbound({
          framesDecoded: 150,
          framesReceived: 150,
          packetsReceived: 100,
          bytesReceived: 400_000,
        }),
      )
      .mockResolvedValueOnce(
        inbound({
          framesDecoded: 300,
          framesReceived: 300,
          packetsReceived: 200,
          bytesReceived: 800_000,
        }),
      )
      .mockResolvedValueOnce(
        inbound({
          framesDecoded: 450,
          framesReceived: 450,
          packetsReceived: 300,
          packetsLost: 5,
          bytesReceived: 1_200_000,
        }),
      )
      .mockRejectedValueOnce(new Error("stats unavailable"));
    const playback = [
      { totalVideoFrames: 0, droppedVideoFrames: 0 },
      { totalVideoFrames: 150, droppedVideoFrames: 0 },
      { totalVideoFrames: 200, droppedVideoFrames: 50 },
      { totalVideoFrames: 350, droppedVideoFrames: 50 },
    ];
    const element = {
      videoWidth: 1280,
      videoHeight: 720,
      getVideoPlaybackQuality: vi.fn(() => playback.shift() ?? playback.at(-1)),
    } as unknown as HTMLVideoElement;
    const unregister = registerQualityVideoElement("screen:viewer:1", element);
    const stop = startViewerQualityMonitor({
      trackName: "screen:viewer:1",
      preset: () => "720p30",
      streamKind: "webcam",
      stats,
    });
    await settleImmediatePoll();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(useQualityStore.getState().snapshots["screen:viewer:1"]).toEqual(
      expect.objectContaining({
        role: "viewer",
        health: "device_limited",
        limitation: "decoder",
        width: 1280,
        height: 720,
        fps: 10,
        targetFps: 30,
        bitrateKbps: 640,
        rid: null,
        codec: "VP9",
      }),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(useQualityStore.getState().snapshots["screen:viewer:1"]).toEqual(
      expect.objectContaining({
        health: "network_limited",
        limitation: "bandwidth",
        fps: 30,
      }),
    );
    expect(api.post).toHaveBeenLastCalledWith(
      "/api/qoe",
      expect.anything(),
      expect.objectContaining({
        samples: [
          expect.objectContaining({
            role: "viewer",
            streamKind: "webcam",
            health: "network_limited",
            limitation: "bandwidth",
            lossPct: 4.8,
            renderFps: 30,
            jitterMs: 10,
          }),
        ],
      }),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(warning).toHaveBeenCalledWith("Viewer QoE sampling failed", expect.any(Error));
    stop();
    unregister();
    expect(useQualityStore.getState().snapshots["screen:viewer:1"]).toBeUndefined();
  });
});
