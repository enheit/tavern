import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@tavern/shared";
import { ScreenShareController } from "@/features/streams/useScreenShare";
import type { ScreenShareDeps } from "@/features/streams/useScreenShare";
import type { ShareSelection } from "@/features/streams/types";
import { PublishSession } from "@/media/rtc/publishSession";
import { useMediaStore } from "@/stores/media";
import { EventLog } from "../../../test/fakes/log";
import { FakeRtcPort } from "../../../test/fakes/rtc";
import { FakeSignal } from "../../../test/fakes/signal";

const USER = "u1";

// A capture track double exposing its stop mock + `end()` to fire the "ended" event the controller
// listens for (OS/browser stop button). §9.1 allows casts for test doubles. `height` (when given)
// backs getSettings() — the acquisition height PublishSession snapshots for the per-rid scales;
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
  let onEnded: ((ev: Event) => void) | null = null;
  const track = {
    kind,
    enabled: true,
    id: `${kind}-x`,
    stop,
    addEventListener: (type: string, cb: (ev: Event) => void) => {
      if (type === "ended") onEnded = cb;
    },
    removeEventListener: () => undefined,
    applyConstraints: vi.fn(async () => undefined),
    ...(height === undefined ? {} : { getSettings: () => ({ height }) }),
  } as unknown as MediaStreamTrack;
  return { track, stop, end: () => onEnded?.(new Event("ended")) };
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

function makeDeps(
  session: PublishSession,
  over: Partial<ScreenShareDeps> = {},
): { deps: ScreenShareDeps; sent: ClientMessage[]; caveat: ReturnType<typeof vi.fn> } {
  const sent: ClientMessage[] = [];
  const caveat = vi.fn();
  const deps: ScreenShareDeps = {
    capture: vi.fn(async () => ({ video: captureTrack("video").track, audio: null })),
    publisher: () => session,
    wsFor: () => ({ send: (msg) => sent.push(msg) }),
    activeServerId: () => "srv",
    caveat,
    ...over,
  };
  return { deps, sent, caveat };
}

const SEL: ShareSelection = { sourceId: "screen:0", preset: "1080p30", withAudio: false };

beforeEach(() => {
  useMediaStore.setState({ sharing: false, sharePreset: null, shareTrackName: null });
});

describe("FR-27 screen share publish", () => {
  it("start publishes h+l encodings from the preset table", async () => {
    const { session, port } = await makePublisher();
    const { deps } = makeDeps(session, {
      capture: async () => ({ video: captureTrack("video").track, audio: null }),
    });
    const controller = new ScreenShareController(deps);

    await controller.start({ sourceId: "screen:0", preset: "720p60", withAudio: false });

    // §App-D 720p60: h = 1800 kbps @ 60fps; l = 250 kbps @ 15fps scaled to ≈270 height. Both scales
    // derive from the acquisition height (no getSettings on this double → preset fallback 720).
    expect(port.last().transceivers[0]?.init.sendEncodings).toEqual([
      { rid: "h", maxBitrate: 1_800_000, maxFramerate: 60, scaleResolutionDownBy: 1 },
      { rid: "l", maxBitrate: 250_000, maxFramerate: 15, scaleResolutionDownBy: 720 / 270 },
    ]);
    expect(useMediaStore.getState().sharing).toBe(true);
    expect(useMediaStore.getState().sharePreset).toBe("720p60");
    expect(useMediaStore.getState().shareTrackName).toBe(`screen:${USER}:1`);
  });

  it("start sends stream.start with audioTrackName only when audio granted", async () => {
    const noAudio = await makePublisher();
    const a = makeDeps(noAudio.session, {
      capture: async () => ({ video: captureTrack("video").track, audio: null }),
    });
    await new ScreenShareController(a.deps).start(SEL);
    const startA = a.sent.find((m) => m.t === "stream.start");
    expect(startA).toEqual({
      t: "stream.start",
      kind: "screen",
      trackName: `screen:${USER}:1`,
      preset: "1080p30",
    });
    expect(a.caveat).not.toHaveBeenCalled();

    const withAudio = await makePublisher();
    const b = makeDeps(withAudio.session, {
      capture: async () => ({
        video: captureTrack("video").track,
        audio: captureTrack("audio").track,
      }),
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
    // FR-28 self-audio caveat fires exactly on the audio share.
    expect(b.caveat).toHaveBeenCalledTimes(1);
  });

  it("track names increment per share (n=1 then n=2)", async () => {
    const { session } = await makePublisher();
    const { deps } = makeDeps(session, {
      capture: async () => ({ video: captureTrack("video").track, audio: null }),
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
      capture: async () => ({ video: video.track, audio: audio.track }),
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
      capture: async () => ({ video: video.track, audio: audio.track }),
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
      capture: async () => ({ video: video.track, audio: null }),
    });

    await expect(new ScreenShareController(deps).start(SEL)).rejects.toThrow("boom");

    expect(useMediaStore.getState().sharing).toBe(false);
    expect(useMediaStore.getState().shareTrackName).toBeNull();
    // the captured track is released so the OS capture indicator clears.
    expect(video.stop).toHaveBeenCalled();
  });
});

describe("FR-27 on-the-fly preset switch", () => {
  it("setPreset caps capture fps only and re-scales both encodings from the acquisition height", async () => {
    const { session, port } = await makePublisher();
    const video = captureTrack("video");
    const { deps } = makeDeps(session, {
      capture: async () => ({ video: video.track, audio: null }),
    });
    const controller = new ScreenShareController(deps);
    await controller.start({ sourceId: "screen:0", preset: "1080p30", withAudio: false });

    await controller.setPreset("480p15");

    // (a) §7.2 ideal/max ONLY (never min/exact), and frame-rate ONLY: capture geometry is fixed at
    // acquisition — a width/height applyConstraints on display capture silently no-ops on some
    // platforms (S12.4), so resolution belongs to the encoder scales in (b).
    expect(video.track.applyConstraints).toHaveBeenCalledWith({
      frameRate: { ideal: 15, max: 15 },
    });
    // (b) h re-priced (App-D 480p15 = 400 kbps @ 15fps) AND re-scaled to the preset height from the
    // acquisition height (fallback 1080 here); l keeps its fixed 250 kbps and its ≈270 target.
    const sender = port.last().transceivers[0]?.sender;
    expect(sender?.encodings[0]).toMatchObject({
      rid: "h",
      maxBitrate: 400_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 1080 / 480,
    });
    expect(sender?.encodings[1]).toMatchObject({
      maxBitrate: 250_000,
      scaleResolutionDownBy: 1080 / 270,
    });
    expect(useMediaStore.getState().sharePreset).toBe("480p15");
  });

  it("scales derive from the REAL acquisition height when the capture is smaller than the preset (S12.4 CI finding)", async () => {
    // A 720-high capture published as 1080p30 (small screen): h cannot upscale (scale 1). Dropping
    // to 480p30 then re-encodes h at 720/480 and l at 720/270 — the capturer is never asked to
    // resize, so the drop reaches viewers even where display-capture applyConstraints no-ops.
    const { session, port } = await makePublisher();
    const video = captureTrack("video", 720);
    const { deps } = makeDeps(session, {
      capture: async () => ({ video: video.track, audio: null }),
    });
    const controller = new ScreenShareController(deps);
    await controller.start({ sourceId: "screen:0", preset: "1080p30", withAudio: false });

    expect(port.last().transceivers[0]?.init.sendEncodings).toEqual([
      { rid: "h", maxBitrate: 2_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
      { rid: "l", maxBitrate: 250_000, maxFramerate: 15, scaleResolutionDownBy: 720 / 270 },
    ]);

    await controller.setPreset("480p30");

    const sender = port.last().transceivers[0]?.sender;
    expect(sender?.encodings[0]).toMatchObject({
      rid: "h",
      scaleResolutionDownBy: 720 / 480,
    });
    expect(sender?.encodings[1]).toMatchObject({ scaleResolutionDownBy: 720 / 270 });
  });

  it("no renegotiation occurs (fake signal layer records zero new offers)", async () => {
    const { session, signal } = await makePublisher();
    const video = captureTrack("video");
    const { deps } = makeDeps(session, {
      capture: async () => ({ video: video.track, audio: null }),
    });
    const controller = new ScreenShareController(deps);
    await controller.start(SEL);
    expect(signal.published).toHaveLength(1); // the initial publish offer

    await controller.setPreset("720p30");

    // A preset switch is applyConstraints + setParameters ONLY — no new publish offer, no renegotiate.
    expect(signal.published).toHaveLength(1);
    expect(signal.renegotiated).toHaveLength(0);
  });

  it("stream.preset sent after a successful local switch", async () => {
    const { session } = await makePublisher();
    const video = captureTrack("video");
    const { deps, sent } = makeDeps(session, {
      capture: async () => ({ video: video.track, audio: null }),
    });
    const controller = new ScreenShareController(deps);
    await controller.start(SEL);

    await controller.setPreset("720p60");

    expect(sent).toContainEqual({
      t: "stream.preset",
      trackName: `screen:${USER}:1`,
      preset: "720p60",
    });
  });

  it("setPreset is a no-op when not sharing (nothing sent)", async () => {
    const { session } = await makePublisher();
    const { deps, sent } = makeDeps(session);
    await new ScreenShareController(deps).setPreset("480p15");
    expect(sent).toHaveLength(0);
  });
});
