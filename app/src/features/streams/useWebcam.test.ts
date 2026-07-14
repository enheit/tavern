import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@tavern/shared";
import { WebcamController, useWebcamStore } from "@/features/streams/useWebcam";
import type { WebcamDeps } from "@/features/streams/useWebcam";
import { PublishSession } from "@/media/rtc/publishSession";
import { EventLog } from "../../../test/fakes/log";
import { FakeRtcPort } from "../../../test/fakes/rtc";
import { FakeSignal } from "../../../test/fakes/signal";

const USER = "u1";

// A capture track double exposing its stop mock + `end()` to fire the "ended" event the controller
// listens for (device removed / OS stop). §9.1 allows casts for test doubles.
function captureTrack(): {
  track: MediaStreamTrack;
  stop: ReturnType<typeof vi.fn>;
  end(): void;
} {
  const stop = vi.fn();
  let onEnded: ((ev: Event) => void) | null = null;
  const track = {
    kind: "video",
    enabled: true,
    id: `video-${Math.random().toString(36).slice(2)}`,
    stop,
    addEventListener: (type: string, cb: (ev: Event) => void) => {
      if (type === "ended") onEnded = cb;
    },
    removeEventListener: () => undefined,
    applyConstraints: vi.fn(async () => undefined),
  } as unknown as MediaStreamTrack;
  return { track, stop, end: () => onEnded?.(new Event("ended")) };
}

// A connected real PublishSession (S7.2) driven by the RTC/signal fakes — the controller publishes
// through it exactly as production does, so the App-D webcam encodings + `cam:{userId}` name (and the
// `camSender()` used by the device switch) are exercised for real.
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

function makeDeps(
  session: PublishSession,
  over: Partial<WebcamDeps> = {},
): {
  deps: WebcamDeps;
  sent: ClientMessage[];
  cams: MediaStreamTrack[];
  stops: ReturnType<typeof vi.fn>[];
} {
  const sent: ClientMessage[] = [];
  const cams: MediaStreamTrack[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const deps: WebcamDeps = {
    getCam: vi.fn(async () => {
      const c = captureTrack();
      cams.push(c.track);
      stops.push(c.stop);
      return c.track;
    }),
    publisher: () => session,
    wsFor: () => ({ send: (msg) => sent.push(msg) }),
    activeServerId: () => "srv",
    cameraDeviceId: () => undefined,
    ...over,
  };
  return { deps, sent, cams, stops };
}

beforeEach(() => {
  sessionStorage.clear();
  useWebcamStore.setState({ active: false, trackName: null, stream: null });
});

describe("FR-29 webcam publish", () => {
  it("starts, replaces, and stops the teaser for a confirmed RTC publication", async () => {
    const { session, port, signal } = await makePublisher();
    const previewId = "123e4567-e89b-42d3-a456-426614174000";
    signal.publishResponse = { ...signal.publishResponse, publicationId: previewId };
    port.last().setConnectionState("connected");
    const publication = { replaceTrack: vi.fn(), stop: vi.fn() };
    const preview = vi.fn(() => publication);
    const { deps, cams } = makeDeps(session, { preview });
    const controller = new WebcamController(deps);

    await controller.start();
    expect(preview).toHaveBeenCalledWith("srv", previewId, cams[0]);
    await controller.switchDevice("cam-2");
    expect(publication.replaceTrack).toHaveBeenCalledWith(cams[1]);
    await controller.stop();
    expect(publication.stop).toHaveBeenCalledTimes(1);
  });

  it("start calls publishSession.publishCam and publishes cam:{userId}", async () => {
    const { session, port } = await makePublisher();
    const publishCam = vi.spyOn(session, "publishCam");
    const { deps } = makeDeps(session);

    await new WebcamController(deps).start();

    expect(publishCam).toHaveBeenCalledTimes(1);
    // §App-D webcam: fixed h = 1000 kbps @ 30fps; l = 150 kbps @ 15fps scaled 720→180.
    expect(port.last().transceivers[0]?.init.sendEncodings).toEqual([
      { rid: "h", maxBitrate: 1_000_000, maxFramerate: 30 },
      { rid: "i", maxBitrate: 350_000, maxFramerate: 30, scaleResolutionDownBy: 2 },
      { rid: "l", maxBitrate: 150_000, maxFramerate: 15, scaleResolutionDownBy: 720 / 180 },
    ]);
    expect(useWebcamStore.getState().active).toBe(true);
    expect(useWebcamStore.getState().trackName).toBe(`cam:${USER}`);
    // Live capture is scoped to this document. Starting a webcam must not save any state that a
    // reload could turn back into an active control or a second capture request.
    expect(sessionStorage.getItem("tavern.voiceSession.v1")).toBeNull();
  });

  it("stream.start payload is kind webcam with preset 720p30", async () => {
    const { session } = await makePublisher();
    const { deps, sent } = makeDeps(session);

    await new WebcamController(deps).start();

    const start = sent.find((m) => m.t === "stream.start");
    // No `cam*` PresetId exists — the wire preset is the existing `720p30` (the cam's dimensions);
    // the real bitrate caps live in the engine's WEBCAM_PRESET/WEBCAM_LOW encodings. No audioTrackName.
    expect(start).toEqual({
      t: "stream.start",
      kind: "webcam",
      trackName: `cam:${USER}`,
      preset: "720p30",
    });
  });

  it("second start while active is a no-op (single cam pinned)", async () => {
    const { session } = await makePublisher();
    const publishCam = vi.spyOn(session, "publishCam");
    const { deps, sent } = makeDeps(session);
    const controller = new WebcamController(deps);

    await controller.start();
    await controller.start();

    // `cam:{userId}` has no per-share counter — the second start does nothing.
    expect(publishCam).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => m.t === "stream.start")).toHaveLength(1);
  });

  it("stop unpublishes, stops the track, sends stream.stop", async () => {
    const { session, signal } = await makePublisher();
    const { deps, sent, stops } = makeDeps(session);
    const controller = new WebcamController(deps);
    await controller.start();

    await controller.stop();

    expect(sent.some((m) => m.t === "stream.stop" && m.trackName === `cam:${USER}`)).toBe(true);
    // The single cam mid is closed.
    expect(signal.closedTracks.at(-1)?.mids).toHaveLength(1);
    expect(stops[0]).toHaveBeenCalled();
    expect(useWebcamStore.getState().active).toBe(false);
    expect(useWebcamStore.getState().trackName).toBeNull();
  });

  it("device switch while active: stop → getCam → replaceTrack, no new offer", async () => {
    const { session, port, signal } = await makePublisher();
    const { deps, cams, stops } = makeDeps(session);
    const controller = new WebcamController(deps);
    await controller.start();
    const offersBefore = signal.published.length;

    await controller.switchDevice("cam-2");

    // FR-22 mic pattern applied to the camera: old track stopped, new device acquired, replaceTrack
    // on the existing sender — and NO renegotiation (publishTracks count unchanged).
    expect(deps.getCam).toHaveBeenLastCalledWith("cam-2");
    expect(stops[0]).toHaveBeenCalled();
    const sender = port.last().transceivers[0]?.sender;
    expect(sender?.replaceTrackArgs.at(-1)).toBe(cams[1]);
    expect(signal.published.length).toBe(offersBefore);
  });
});
