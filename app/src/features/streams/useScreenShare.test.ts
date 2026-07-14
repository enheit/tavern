import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@tavern/shared";
import { ScreenShareController } from "@/features/streams/useScreenShare";
import type { ScreenShareDeps } from "@/features/streams/useScreenShare";
import type { ShareSelection } from "@/features/streams/types";
import type { ScreenCapture } from "@/media/capture";
import { PublishSession } from "@/media/rtc/publishSession";
import { resetQualityMonitoringForTests } from "@/media/qualityMonitor";
import { useMediaStore } from "@/stores/media";
import { EventLog } from "../../../test/fakes/log";
import { FakeRtcPort } from "../../../test/fakes/rtc";
import { FakeSignal } from "../../../test/fakes/signal";

const USER = "u1";

// A capture track double exposing its stop mock + `end()` to fire the "ended" event the controller
// listens for (OS/browser stop button). §9.1 allows casts for test doubles. `height` (when given)
// backs getSettings() — the acquisition height PublishSession snapshots for the encoder scale;
// omitted, the track has no getSettings and the session falls back to the preset height.
function captureTrack(
  kind: "audio" | "video",
  height?: number,
): {
  track: MediaStreamTrack;
  stop: ReturnType<typeof vi.fn>;
  end(): void;
} {
  const stop = vi.fn();
  const ended = new Set<(ev: Event) => void>();
  const track = {
    kind,
    enabled: true,
    id: `${kind}-x`,
    stop,
    contentHint: "",
    addEventListener: (type: string, cb: (ev: Event) => void) => {
      if (type === "ended") ended.add(cb);
    },
    removeEventListener: (type: string, cb: (ev: Event) => void) => {
      if (type === "ended") ended.delete(cb);
    },
    applyConstraints: vi.fn(async () => undefined),
    ...(height === undefined ? {} : { getSettings: () => ({ height }) }),
  } as unknown as MediaStreamTrack;
  return {
    track,
    stop,
    end: () => {
      for (const cb of ended) cb(new Event("ended"));
    },
  };
}

// A connected real PublishSession (S7.2) driven by the RTC/signal fakes — the controller publishes
// through it exactly as production does, so the App-D encodings + `n` counter are exercised for real.
async function makePublisher(): Promise<{
  session: PublishSession;
  port: FakeRtcPort;
  signal: FakeSignal;
}> {
  const log = new EventLog();
  const port = new FakeRtcPort(log);
  const signal = new FakeSignal(log);
  const session = new PublishSession({ rtc: port, signal, serverId: "srv", userId: USER });
  await session.connect();
  return { session, port, signal };
}

async function flush(): Promise<void> {
  await Array.from({ length: 25 }).reduce<Promise<void>>(
    (p) => p.then(() => undefined),
    Promise.resolve(),
  );
}

// Wraps tracks in the ScreenCapture shape captureScreen returns; audioSource defaults to
// "display" when audio is present (the pre-fallback path these publish tests exercise).
function screenCapture(
  video: MediaStreamTrack,
  audio: MediaStreamTrack | null,
  audioSource: ScreenCapture["audioSource"] = audio === null ? null : "display",
): ScreenCapture {
  return { video, audio, audioSource, tabAudio: false };
}

function makeDeps(
  session: PublishSession,
  over: Partial<ScreenShareDeps> = {},
): { deps: ScreenShareDeps; sent: ClientMessage[]; notice: ReturnType<typeof vi.fn> } {
  const sent: ClientMessage[] = [];
  const notice = vi.fn();
  const deps: ScreenShareDeps = {
    capture: vi.fn(async () => screenCapture(captureTrack("video").track, null)),
    publisher: () => session,
    wsFor: () => ({ send: (msg) => sent.push(msg) }),
    activeServerId: () => "srv",
    notice,
    ...over,
  };
  return { deps, sent, notice };
}

const SEL: ShareSelection = {
  sourceId: "screen:0",
  preset: "1080p30",
  codec: "vp8",
  withAudio: false,
};

beforeEach(() => {
  useMediaStore.setState({ sharing: false, sharePreset: null, shareTrackName: null });
});

afterEach(() => resetQualityMonitoringForTests());

describe("FR-27 screen share publish", () => {
  it("starts, replaces, and stops the teaser for a confirmed RTC publication", async () => {
    const { session, port, signal } = await makePublisher();
    const previewId = "123e4567-e89b-42d3-a456-426614174000";
    signal.publishResponse = {
      ...signal.publishResponse,
      publicationId: previewId,
    };
    port.last().setConnectionState("connected");
    const first = captureTrack("video");
    const second = captureTrack("video");
    const capture = vi
      .fn<ScreenShareDeps["capture"]>()
      .mockResolvedValueOnce(screenCapture(first.track, null))
      .mockResolvedValueOnce(screenCapture(second.track, null));
    const publication = { replaceTrack: vi.fn(), stop: vi.fn() };
    const preview = vi.fn(() => publication);
    const { deps } = makeDeps(session, { capture, preview });
    const controller = new ScreenShareController(deps);

    await controller.start(SEL);
    expect(controller.codec).toBe("vp8");
    expect(preview).toHaveBeenCalledWith("srv", previewId, first.track);
    await controller.replaceCapture({ ...SEL, preset: "1440p60" });
    expect(publication.replaceTrack).toHaveBeenCalledWith(second.track);
    await controller.stop();
    expect(controller.codec).toBeNull();
    expect(publication.stop).toHaveBeenCalledTimes(1);
  });

  it("start publishes only the selected encoding from the preset table", async () => {
    const { session, port } = await makePublisher();
    const { deps } = makeDeps(session, {
      capture: async () => screenCapture(captureTrack("video").track, null),
    });
    const controller = new ScreenShareController(deps);

    await controller.start({
      sourceId: "screen:0",
      preset: "720p60",
      codec: "vp8",
      withAudio: false,
    });

    expect(port.last().transceivers[0]?.init.sendEncodings).toEqual([
      { maxBitrate: 3_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 },
    ]);
    expect(useMediaStore.getState().sharing).toBe(true);
    expect(useMediaStore.getState().sharePreset).toBe("720p60");
    expect(useMediaStore.getState().shareTrackName).toBe(`screen:${USER}:1`);
  });

  it("start sends stream.start with audioTrackName only when audio granted", async () => {
    const noAudio = await makePublisher();
    const a = makeDeps(noAudio.session, {
      capture: async () => screenCapture(captureTrack("video").track, null),
    });
    await new ScreenShareController(a.deps).start(SEL);
    const startA = a.sent.find((m) => m.t === "stream.start");
    expect(startA).toEqual({
      t: "stream.start",
      kind: "screen",
      trackName: `screen:${USER}:1`,
      preset: "1080p30",
    });
    // notice fires on every start — with a null audioSource here (no audio was captured).
    expect(a.notice).toHaveBeenCalledWith(expect.objectContaining({ audioSource: null }), false);

    const withAudio = await makePublisher();
    const b = makeDeps(withAudio.session, {
      capture: async () => screenCapture(captureTrack("video").track, captureTrack("audio").track),
    });
    await new ScreenShareController(b.deps).start({ ...SEL, withAudio: true });
    const startB = b.sent.find((m) => m.t === "stream.start");
    expect(startB).toEqual({
      t: "stream.start",
      kind: "screen",
      trackName: `screen:${USER}:1`,
      audioTrackName: `screenAudio:${USER}:1`,
      preset: "1080p30",
    });
    // FR-28 share-audio notice carries the capture (display origin) + the audio intent.
    expect(b.notice).toHaveBeenCalledTimes(1);
    expect(b.notice).toHaveBeenCalledWith(
      expect.objectContaining({ audioSource: "display" }),
      true,
    );
  });

  it("track names increment per share (n=1 then n=2)", async () => {
    const { session } = await makePublisher();
    const { deps } = makeDeps(session, {
      capture: async () => screenCapture(captureTrack("video").track, null),
    });
    const controller = new ScreenShareController(deps);

    await controller.start(SEL);
    expect(useMediaStore.getState().shareTrackName).toBe(`screen:${USER}:1`);
    await controller.stop();
    await controller.start(SEL);
    expect(useMediaStore.getState().shareTrackName).toBe(`screen:${USER}:2`);
  });

  it("onended sends stream.stop and unpublishes both tracks", async () => {
    const { session, signal } = await makePublisher();
    const video = captureTrack("video");
    const audio = captureTrack("audio");
    const { deps, sent } = makeDeps(session, {
      capture: async () => screenCapture(video.track, audio.track),
    });
    await new ScreenShareController(deps).start({ ...SEL, withAudio: true });

    // OS/browser stop button → the captured video track's "ended" event.
    video.end();
    await flush();

    expect(sent.some((m) => m.t === "stream.stop" && m.trackName === `screen:${USER}:1`)).toBe(
      true,
    );
    // both the screen video mid and the screenAudio mid were closed in one op.
    expect(signal.closedTracks.at(-1)?.mids).toHaveLength(2);
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(useMediaStore.getState().sharing).toBe(false);
  });

  it("manual stop mirrors onended path", async () => {
    const { session, signal } = await makePublisher();
    const video = captureTrack("video");
    const audio = captureTrack("audio");
    const { deps, sent } = makeDeps(session, {
      capture: async () => screenCapture(video.track, audio.track),
    });
    const controller = new ScreenShareController(deps);
    await controller.start({ ...SEL, withAudio: true });

    await controller.stop();

    expect(sent.some((m) => m.t === "stream.stop" && m.trackName === `screen:${USER}:1`)).toBe(
      true,
    );
    expect(signal.closedTracks.at(-1)?.mids).toHaveLength(2);
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(useMediaStore.getState().shareTrackName).toBeNull();
  });

  it("start rejects when engine publish fails and leaves state idle", async () => {
    const { session } = await makePublisher();
    vi.spyOn(session, "publishStream").mockRejectedValueOnce(new Error("boom"));
    const video = captureTrack("video");
    const { deps } = makeDeps(session, {
      capture: async () => screenCapture(video.track, null),
    });

    await expect(new ScreenShareController(deps).start(SEL)).rejects.toThrow("boom");

    expect(useMediaStore.getState().sharing).toBe(false);
    expect(useMediaStore.getState().shareTrackName).toBeNull();
    // the captured track is released so the OS capture indicator clears.
    expect(video.stop).toHaveBeenCalled();
  });
});

describe("FR-27 on-the-fly preset switch", () => {
  it("setPreset avoids capture constraints and re-scales the encoding from acquisition height", async () => {
    const { session, port } = await makePublisher();
    const video = captureTrack("video");
    const { deps } = makeDeps(session, {
      capture: async () => screenCapture(video.track, null),
    });
    const controller = new ScreenShareController(deps);
    await controller.start({ ...SEL, sourceId: "screen:0", preset: "1080p30" });

    await controller.setPreset("480p15");

    expect(video.track.applyConstraints).not.toHaveBeenCalled();
    const sender = port.last().transceivers[0]?.sender;
    expect(sender?.encodings[0]).toMatchObject({
      maxBitrate: 400_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 1080 / 480,
    });
    expect(sender?.encodings).toHaveLength(1);
    expect(useMediaStore.getState().sharePreset).toBe("480p15");
  });

  it("scales derive from the REAL acquisition height when the capture is smaller than the preset (S12.4 CI finding)", async () => {
    // A 720-high capture published as 1080p30 (small screen) cannot upscale (scale 1). Dropping
    // to 480p30 then re-encodes from 720 — the capturer is never asked to
    // resize, so the drop reaches viewers even where display-capture applyConstraints no-ops.
    const { session, port } = await makePublisher();
    const video = captureTrack("video", 720);
    const { deps } = makeDeps(session, {
      capture: async () => screenCapture(video.track, null),
    });
    const controller = new ScreenShareController(deps);
    await controller.start({ ...SEL, sourceId: "screen:0", preset: "1080p30" });

    expect(port.last().transceivers[0]?.init.sendEncodings).toEqual([
      { maxBitrate: 3_500_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
    ]);

    await controller.setPreset("480p30");

    const sender = port.last().transceivers[0]?.sender;
    expect(sender?.encodings[0]).toMatchObject({
      scaleResolutionDownBy: 720 / 480,
    });
    expect(sender?.encodings).toHaveLength(1);
  });

  it("no renegotiation occurs (fake signal layer records zero new offers)", async () => {
    const { session, signal } = await makePublisher();
    const video = captureTrack("video");
    const { deps } = makeDeps(session, {
      capture: async () => screenCapture(video.track, null),
    });
    const controller = new ScreenShareController(deps);
    await controller.start(SEL);
    expect(signal.published).toHaveLength(1); // the initial publish offer

    await controller.setPreset("720p30");

    // A preset switch is sender.setParameters only — no new publish offer or renegotiate.
    expect(signal.published).toHaveLength(1);
    expect(signal.renegotiated).toHaveLength(0);
  });

  it("rejects an fps upgrade beyond the capture ceiling without changing advertised preset", async () => {
    const { session } = await makePublisher();
    const video = captureTrack("video");
    const { deps, sent } = makeDeps(session, {
      capture: async () => screenCapture(video.track, null),
    });
    const controller = new ScreenShareController(deps);
    await controller.start(SEL);

    await expect(controller.setPreset("720p60")).rejects.toThrow("capture_upgrade_required");

    expect(sent.some((message) => message.t === "stream.preset")).toBe(false);
  });

  it("upward capture replacement preserves the track name/audio topology and stops old video last", async () => {
    const { session, signal, port } = await makePublisher();
    const oldVideo = captureTrack("video", 1080);
    const audio = captureTrack("audio");
    const nextVideo = captureTrack("video", 1440);
    const capture = vi
      .fn<ScreenShareDeps["capture"]>()
      .mockResolvedValueOnce(screenCapture(oldVideo.track, audio.track))
      .mockResolvedValueOnce(screenCapture(nextVideo.track, null));
    const { deps, sent } = makeDeps(session, { capture });
    const controller = new ScreenShareController(deps);
    await controller.start({ ...SEL, sourceId: "screen:0", preset: "1080p30", withAudio: true });

    await controller.replaceCapture({
      ...SEL,
      sourceId: "screen:0",
      preset: "1440p60",
      withAudio: true,
    });

    expect(sent).toContainEqual({
      t: "stream.preset",
      trackName: `screen:${USER}:1`,
      preset: "1440p60",
    });
    expect(signal.published).toHaveLength(1);
    expect(port.last().transceivers).toHaveLength(2);
    expect(port.last().transceivers[0]?.sender.track).toBe(nextVideo.track);
    expect(oldVideo.stop).toHaveBeenCalledTimes(1);
    expect(audio.stop).not.toHaveBeenCalled();
    expect(useMediaStore.getState().shareTrackName).toBe(`screen:${USER}:1`);
    expect(controller.captureCeiling).toBe("1440p60");
  });

  it("setPreset is a no-op when not sharing (nothing sent)", async () => {
    const { session } = await makePublisher();
    const { deps, sent } = makeDeps(session);
    await new ScreenShareController(deps).setPreset("480p15");
    expect(sent).toHaveLength(0);
  });
});
