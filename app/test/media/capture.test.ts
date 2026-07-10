import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformBridge } from "@/platform/types";
import { captureScreen, getCam, getMic, getScreen, retoggleMic } from "@/media/capture";
import { fakeStream, fakeTrack } from "../fakes/media";

// captureScreen (S8.1) reads the platform singleton (getScreen keeps DI), so the singleton is mocked
// here; the getScreen tests pass their own bridge and are unaffected.
const platformMock = vi.hoisted(() => ({
  kind: "desktop" as "desktop" | "web",
  capture: {
    getScreenSources: vi.fn(async () => []),
    selectSource: vi.fn(async () => undefined),
    loopbackAudioSupported: vi.fn(async () => true),
  },
}));
vi.mock("@/platform/types", () => ({ platform: platformMock }));

let getUserMedia: ReturnType<typeof vi.fn>;
let getDisplayMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getUserMedia = vi.fn(async () => fakeStream({ audio: [fakeTrack("audio")] }));
  getDisplayMedia = vi.fn(async () => fakeStream({ video: [fakeTrack("video")] }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, getDisplayMedia } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function platformWithLoopback(supported: boolean): PlatformBridge {
  return {
    capture: { loopbackAudioSupported: vi.fn(async () => supported) },
  } as unknown as PlatformBridge;
}

// The constraints object passed to the nth mock call (throws if that call was never made).
function nthConstraints(mock: ReturnType<typeof vi.fn>, n: number): Record<string, unknown> {
  const call = mock.mock.calls.at(n);
  if (!call) throw new Error(`no call #${n} recorded`);
  return call[0] as Record<string, unknown>;
}

// Recursively assert a constraint object carries none of the forbidden keys.
function assertNoKeys(value: unknown, forbidden: string[]): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(forbidden).not.toContain(key);
    assertNoKeys(child, forbidden);
  }
}

describe("FR-22 noise toggle", () => {
  it("retoggle = stop → getUserMedia(new constraints) → replaceTrack (order)", async () => {
    const order: string[] = [];
    const current = {
      kind: "audio",
      stop: vi.fn(() => order.push("stop")),
    } as unknown as MediaStreamTrack;
    getUserMedia.mockImplementation(async () => {
      order.push("getUserMedia");
      return fakeStream({ audio: [fakeTrack("audio")] });
    });
    const sender = {
      replaceTrack: vi.fn(async () => {
        order.push("replaceTrack");
      }),
    } as unknown as RTCRtpSender;

    const next = await retoggleMic(current, sender, { noiseSuppression: false });

    expect(order).toEqual(["stop", "getUserMedia", "replaceTrack"]);
    expect(sender.replaceTrack).toHaveBeenCalledWith(next);
  });

  it("echoCancellation is true in every getUserMedia call; the toggle drives NS + AGC together", async () => {
    await getMic({ noiseSuppression: true });
    await getMic({ noiseSuppression: false, deviceId: "mic-2" });
    await retoggleMic(
      fakeTrack("audio"),
      { replaceTrack: vi.fn(async () => undefined) } as unknown as RTCRtpSender,
      { noiseSuppression: true },
    );

    for (const call of getUserMedia.mock.calls) {
      const audio = (call[0] as { audio: Record<string, unknown> }).audio;
      expect(audio.echoCancellation).toBe(true);
      expect(audio.noiseSuppression).toBe(audio.autoGainControl); // NS + AGC follow one toggle
    }
    // deviceId only appears when supplied (no undefined key)
    const second = nthConstraints(getUserMedia, 1).audio as Record<string, unknown>;
    expect(second.deviceId).toEqual({ exact: "mic-2" });
    const first = nthConstraints(getUserMedia, 0).audio as Record<string, unknown>;
    expect("deviceId" in first).toBe(false);
  });
});

describe("FR-27 screen constraints", () => {
  it("only ideal/max keys are present in the getDisplayMedia video constraints", async () => {
    await getScreen(platformWithLoopback(false), "1080p30", false);
    const constraints = nthConstraints(getDisplayMedia, 0);
    expect(constraints.video).toEqual({
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    });
    assertNoKeys(constraints.video, ["min", "exact"]);
  });

  it("requests loopback audio only when wanted AND the OS supports it", async () => {
    const supported = platformWithLoopback(true);
    const audioResult = await getScreen(supported, "720p30", true);
    expect(nthConstraints(getDisplayMedia, 0).audio).toBe(true);
    expect(supported.capture.loopbackAudioSupported).toHaveBeenCalled();

    getDisplayMedia.mockClear();
    const unsupported = platformWithLoopback(false);
    await getScreen(unsupported, "720p30", true);
    expect(nthConstraints(getDisplayMedia, 0).audio).toBe(false);

    // no audio track surfaces when the OS gives us none
    expect(audioResult.audio).toBeNull();
  });

  it("returns the stream's audio track when the OS provides one", async () => {
    const audioTrack = fakeTrack("audio");
    getDisplayMedia.mockResolvedValueOnce(
      fakeStream({ video: [fakeTrack("video")], audio: [audioTrack] }),
    );
    const result = await getScreen(platformWithLoopback(true), "1080p30", true);
    expect(result.audio).toBe(audioTrack);
  });
});

describe("FR-27 captureScreen", () => {
  beforeEach(() => {
    platformMock.kind = "desktop";
    platformMock.capture.selectSource.mockClear();
  });

  it("desktop: arms selectSource then getDisplayMedia (ideal/max-only video + requested audio)", async () => {
    const result = await captureScreen({ sourceId: "screen:2", preset: "720p30", withAudio: true });

    expect(platformMock.capture.selectSource).toHaveBeenCalledWith("screen:2");
    const constraints = nthConstraints(getDisplayMedia, 0);
    expect(constraints.video).toEqual({
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    });
    assertNoKeys(constraints.video, ["min", "exact"]);
    expect(constraints.audio).toBe(true);
    expect(result.video.kind).toBe("video");
    expect(result.audio).toBeNull();
  });

  it("web: calls getDisplayMedia directly without arming a source", async () => {
    platformMock.kind = "web";
    await captureScreen({ sourceId: null, preset: "1080p30", withAudio: false });

    expect(platformMock.capture.selectSource).not.toHaveBeenCalled();
    expect(nthConstraints(getDisplayMedia, 0).audio).toBe(false);
  });

  it("surfaces the audio track when the picker returns one", async () => {
    const audioTrack = fakeTrack("audio");
    getDisplayMedia.mockResolvedValueOnce(
      fakeStream({ video: [fakeTrack("video")], audio: [audioTrack] }),
    );
    const result = await captureScreen({ sourceId: "screen:0", preset: "480p15", withAudio: true });
    expect(result.audio).toBe(audioTrack);
  });
});

describe("FR-21 camera capture", () => {
  it("captures a fixed 720p30 webcam track with an optional exact deviceId", async () => {
    getUserMedia.mockResolvedValue(fakeStream({ video: [fakeTrack("video")] }));
    await getCam("cam-1");
    const video = nthConstraints(getUserMedia, 0).video as Record<string, unknown>;
    expect(video).toEqual({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      deviceId: { exact: "cam-1" },
    });

    getUserMedia.mockClear();
    getUserMedia.mockResolvedValue(fakeStream({ video: [fakeTrack("video")] }));
    await getCam();
    const noDevice = nthConstraints(getUserMedia, 0).video as Record<string, unknown>;
    expect("deviceId" in noDevice).toBe(false);
  });

  it("throws when the acquired stream has no track of the expected kind", async () => {
    getUserMedia.mockResolvedValueOnce(fakeStream());
    await expect(getMic({ noiseSuppression: false })).rejects.toThrow("no audio track");
    getUserMedia.mockResolvedValueOnce(fakeStream());
    await expect(getCam()).rejects.toThrow("no video track");
  });
});
