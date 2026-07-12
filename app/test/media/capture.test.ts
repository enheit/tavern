import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureScreen,
  getCam,
  getMic,
  pickSystemAudioDevice,
  retoggleMic,
  TAVERN_STREAM_AUDIO_LABEL,
  VENMIC_STREAM_AUDIO_LABEL,
} from "@/media/capture";
import { useSettingsStore } from "@/stores/settings";
import { fakeStream, fakeTrack } from "../fakes/media";

// captureScreen reads the platform singleton (S8.1) — mocked here with togglable kind/os/isE2E.
const platformMock = vi.hoisted(() => ({
  kind: "desktop" as "desktop" | "web",
  os: "win32" as "win32" | "darwin" | "linux" | "web",
  isE2E: false,
  capture: {
    getScreenSources: vi.fn(async () => []),
    selectSource: vi.fn(async () => undefined),
    loopbackAudioSupported: vi.fn(async () => true),
  },
}));
vi.mock("@/platform/types", () => ({ platform: platformMock }));

let getUserMedia: ReturnType<typeof vi.fn>;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;

function device(kind: string, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "" } as MediaDeviceInfo;
}

beforeEach(() => {
  getUserMedia = vi.fn(async () => fakeStream({ audio: [fakeTrack("audio")] }));
  getDisplayMedia = vi.fn(async () => fakeStream({ video: [fakeTrack("video")] }));
  enumerateDevices = vi.fn(async () => []);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia, getDisplayMedia, enumerateDevices },
  });
  platformMock.kind = "desktop";
  platformMock.os = "win32";
  platformMock.isE2E = false;
  platformMock.capture.selectSource.mockClear();
  setStreamAudio(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

// exactOptionalPropertyTypes: clearing the pref means DELETING the key, not writing undefined.
function setStreamAudio(streamAudio: string | undefined): void {
  const settings = useSettingsStore.getState();
  const next = { ...settings.deviceSettings };
  delete next.streamAudio;
  if (streamAudio !== undefined) next.streamAudio = streamAudio;
  settings.setDeviceSettings(next);
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

    const next = await retoggleMic(current, sender, { noiseSuppression: "off" });

    expect(order).toEqual(["stop", "getUserMedia", "replaceTrack"]);
    expect(sender.replaceTrack).toHaveBeenCalledWith(next);
  });

  // Task-2 voice-capture matrix: AEC always on; NS only in "standard" ("deepfilter" feeds its model
  // the unprocessed signal); AGC defaults OFF but is opt-in per opts; 48 kHz mono capture for all modes.
  it("constraint matrix: AEC always on, NS per mode, AGC opt-in, 48kHz mono everywhere", async () => {
    await getMic({ noiseSuppression: "standard" });
    await getMic({ noiseSuppression: "off", deviceId: "mic-2" });
    await getMic({ noiseSuppression: "deepfilter" });
    await getMic({ noiseSuppression: "deepfilter", autoGainControl: true });
    await retoggleMic(
      fakeTrack("audio"),
      { replaceTrack: vi.fn(async () => undefined) } as unknown as RTCRtpSender,
      { noiseSuppression: "standard" },
    );

    for (const call of getUserMedia.mock.calls) {
      const audio = (call[0] as { audio: Record<string, unknown> }).audio;
      expect(audio.echoCancellation).toBe(true);
      expect(audio.channelCount).toEqual({ ideal: 1 });
      expect(audio.sampleRate).toEqual({ ideal: 48000 });
    }
    const byMode = (n: number): Record<string, unknown> =>
      nthConstraints(getUserMedia, n).audio as Record<string, unknown>;
    expect(byMode(0).noiseSuppression).toBe(true); // standard = browser NS
    expect(byMode(1).noiseSuppression).toBe(false); // off = raw
    expect(byMode(2).noiseSuppression).toBe(false); // deepfilter = model sees unprocessed signal
    // AGC defaults off, honored when explicitly enabled
    expect(byMode(2).autoGainControl).toBe(false);
    expect(byMode(3).autoGainControl).toBe(true);
    // deviceId only appears when supplied (no undefined key)
    expect(byMode(1).deviceId).toEqual({ exact: "mic-2" });
    expect("deviceId" in byMode(0)).toBe(false);
  });

  it("e2e harness: ALL processing off and no worklet keys (steady-tone seam)", async () => {
    platformMock.isE2E = true;
    await getMic({ noiseSuppression: "deepfilter" });
    const audio = nthConstraints(getUserMedia, 0).audio as Record<string, unknown>;
    expect(audio).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });
});

describe("FR-27 captureScreen", () => {
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
    expect(result.audioSource).toBeNull();
  });

  it("web: calls getDisplayMedia directly without arming a source", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    await captureScreen({ sourceId: null, preset: "1080p30", withAudio: false });

    expect(platformMock.capture.selectSource).not.toHaveBeenCalled();
    expect(nthConstraints(getDisplayMedia, 0).audio).toBe(false);
  });

  it("surfaces display audio as audioSource 'display'", async () => {
    const audioTrack = fakeTrack("audio");
    getDisplayMedia.mockResolvedValueOnce(
      fakeStream({ video: [fakeTrack("video")], audio: [audioTrack] }),
    );
    const result = await captureScreen({ sourceId: "screen:0", preset: "480p15", withAudio: true });
    expect(result.audio).toBe(audioTrack);
    expect(result.audioSource).toBe("display");
  });
});

describe("FR-28 system-audio fallback", () => {
  const monitorDevices = [
    device("videoinput", "cam-1", "FaceCam"),
    device("audioinput", "mic-1", "Blue Yeti"),
    device("audioinput", "mon-1", "Monitor of Built-in Audio Analog Stereo"),
  ];

  it("web: no display audio + a monitor-labeled input → AEC-on/NS-off/AGC-off capture of it", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    enumerateDevices.mockResolvedValue(monitorDevices);

    const result = await captureScreen({ sourceId: null, preset: "1080p30", withAudio: true });

    expect(nthConstraints(getUserMedia, 0)).toEqual({
      audio: {
        deviceId: { exact: "mon-1" },
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    expect(result.audio?.kind).toBe("audio");
    expect(result.audioSource).toBe("monitor");
    expect(result.tabAudio).toBe(false);
  });

  it("web: display audio present → fallback never runs", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    enumerateDevices.mockResolvedValue(monitorDevices);
    getDisplayMedia.mockResolvedValueOnce(
      fakeStream({ video: [fakeTrack("video")], audio: [fakeTrack("audio")] }),
    );

    const result = await captureScreen({ sourceId: null, preset: "1080p30", withAudio: true });

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.audioSource).toBe("display");
  });

  it("web: tab share (displaySurface 'browser') without audio → the user's decline is honored", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    enumerateDevices.mockResolvedValue(monitorDevices);
    const tabVideo = fakeTrack("video");
    (tabVideo as { getSettings?: () => unknown }).getSettings = () => ({
      displaySurface: "browser",
    });
    getDisplayMedia.mockResolvedValueOnce(fakeStream({ video: [tabVideo] }));

    const result = await captureScreen({ sourceId: null, preset: "1080p30", withAudio: true });

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.audio).toBeNull();
  });

  it("explicit settings device wins over display audio (no audio in the display request)", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    setStreamAudio("mic-1");
    enumerateDevices.mockResolvedValue(monitorDevices);

    const result = await captureScreen({ sourceId: null, preset: "1080p30", withAudio: true });

    expect(nthConstraints(getDisplayMedia, 0).audio).toBe(false);
    const audio = nthConstraints(getUserMedia, 0).audio as Record<string, unknown>;
    expect(audio.deviceId).toEqual({ exact: "mic-1" });
    expect(result.audioSource).toBe("monitor");
  });

  it("'off' disables the fallback; missing devices degrade to video-only", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    setStreamAudio("off");
    enumerateDevices.mockResolvedValue(monitorDevices);
    const off = await captureScreen({ sourceId: null, preset: "1080p30", withAudio: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(off.audio).toBeNull();

    setStreamAudio(undefined);
    enumerateDevices.mockResolvedValue([device("audioinput", "mic-1", "Blue Yeti")]);
    const none = await captureScreen({ sourceId: null, preset: "1080p30", withAudio: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(none.audio).toBeNull();
    expect(none.audioSource).toBeNull();
  });

  it("desktop linux: display request never asks for audio; fallback provides it", async () => {
    platformMock.kind = "desktop";
    platformMock.os = "linux";
    enumerateDevices.mockResolvedValue([
      device("audioinput", "tavern-1", TAVERN_STREAM_AUDIO_LABEL),
    ]);

    const result = await captureScreen({ sourceId: "screen:0", preset: "720p30", withAudio: true });

    // The armed handler has no loopback device on linux — an audio-carrying display request
    // would go unanswered, so the capture itself must not ask.
    expect(nthConstraints(getDisplayMedia, 0).audio).toBe(false);
    expect(result.audioSource).toBe("monitor");
  });

  it("desktop linux + venmic node: captured WITHOUT echo cancellation (already voice-free)", async () => {
    platformMock.kind = "desktop";
    platformMock.os = "linux";
    enumerateDevices.mockResolvedValue([
      device("audioinput", "venmic-1", VENMIC_STREAM_AUDIO_LABEL),
      device("audioinput", "tavern-1", TAVERN_STREAM_AUDIO_LABEL),
    ]);

    const result = await captureScreen({ sourceId: "screen:0", preset: "720p30", withAudio: true });

    expect(nthConstraints(getUserMedia, 0)).toEqual({
      audio: {
        deviceId: { exact: "venmic-1" },
        echoCancellation: false, // per-PID exclusion at the PipeWire level replaces AEC here
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    expect(result.audioSource).toBe("monitor");
  });

  it("desktop win32: no fallback (loopback rides the display request)", async () => {
    platformMock.kind = "desktop";
    platformMock.os = "win32";
    enumerateDevices.mockResolvedValue(monitorDevices);

    const result = await captureScreen({ sourceId: "screen:0", preset: "720p30", withAudio: true });

    expect(nthConstraints(getDisplayMedia, 0).audio).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.audio).toBeNull();
  });

  it("e2e harness: auto-mode fallback is skipped; an explicit device opts in", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    platformMock.isE2E = true;
    enumerateDevices.mockResolvedValue(monitorDevices);
    const auto = await captureScreen({ sourceId: null, preset: "1080p30", withAudio: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(auto.audio).toBeNull();

    setStreamAudio("mon-1");
    const explicit = await captureScreen({ sourceId: null, preset: "1080p30", withAudio: true });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(explicit.audioSource).toBe("monitor");
  });

  it("getUserMedia failure degrades to a video-only share (never throws)", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    enumerateDevices.mockResolvedValue(monitorDevices);
    getUserMedia.mockRejectedValueOnce(new Error("NotReadableError"));

    const result = await captureScreen({ sourceId: null, preset: "1080p30", withAudio: true });

    expect(result.video.kind).toBe("video");
    expect(result.audio).toBeNull();
    expect(result.audioSource).toBeNull();
  });
});

describe("FR-28 pickSystemAudioDevice", () => {
  const inputs = [
    device("audioinput", "mic-1", "Blue Yeti"),
    device("audioinput", "virt-1", "My Virtual Monitor Source"),
    device("audioinput", "tavern-1", TAVERN_STREAM_AUDIO_LABEL),
    device("audiooutput", "out-1", "Monitor Speakers"),
  ];

  it("explicit id: exact match or null (never a heuristic substitute)", () => {
    expect(pickSystemAudioDevice(inputs, "mic-1")?.deviceId).toBe("mic-1");
    expect(pickSystemAudioDevice(inputs, "gone")).toBeNull();
  });

  it("auto: Tavern's own remap-source outranks other monitor-ish inputs", () => {
    expect(pickSystemAudioDevice(inputs, null)?.deviceId).toBe("tavern-1");
  });

  it("auto: the venmic virtual mic outranks even the remap-source (Task-3)", () => {
    const withVenmic = [...inputs, device("audioinput", "venmic-1", VENMIC_STREAM_AUDIO_LABEL)];
    expect(pickSystemAudioDevice(withVenmic, null)?.deviceId).toBe("venmic-1");
  });

  it("auto: falls back to the first /monitor/i-labeled INPUT (outputs never match)", () => {
    const noTavern = inputs.filter((d) => d.deviceId !== "tavern-1");
    expect(pickSystemAudioDevice(noTavern, null)?.deviceId).toBe("virt-1");
    expect(pickSystemAudioDevice([device("audiooutput", "out-1", "Monitor")], null)).toBeNull();
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
    await expect(getMic({ noiseSuppression: "off" })).rejects.toThrow("no audio track");
    getUserMedia.mockResolvedValueOnce(fakeStream());
    await expect(getCam()).rejects.toThrow("no video track");
  });
});
