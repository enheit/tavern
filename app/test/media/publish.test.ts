import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PresetId } from "@tavern/shared";
import { PublishSession } from "@/media/rtc/publishSession";
import { EventLog } from "../fakes/log";
import { fakeTrack } from "../fakes/media";
import { FakeRtcPort } from "../fakes/rtc";
import { FakeSignal } from "../fakes/signal";

const USER = "user-1";

let log: EventLog;
let port: FakeRtcPort;
let signal: FakeSignal;
let session: PublishSession;

async function connect(): Promise<void> {
  await session.connect();
  log.clear(); // drop the getIceServers/newSession preamble so the flow log is clean
}

beforeEach(() => {
  log = new EventLog();
  port = new FakeRtcPort(log);
  signal = new FakeSignal(log);
  session = new PublishSession({ rtc: port, signal, serverId: "srv", userId: USER });
});

describe("FR-19 publish flow", () => {
  it("connect → offer flow ordering", async () => {
    await session.connect();
    // connect: ICE then a new SFU session, before any transceiver exists.
    expect(log.entries).toEqual(["getIceServers", "newSession"]);
    expect(session.state).toBe("connected");
    expect(session.sessionId).toBe("sess-1");
    expect(port.last().config.bundlePolicy).toBe("max-bundle");

    log.clear();
    const { trackName } = await session.publishMic(fakeTrack("audio"));
    expect(trackName).toBe(`mic:${USER}`);
    expect(log.entries).toEqual([
      "addTransceiver",
      "createOffer",
      "setLocalDescription",
      "publishTracks",
      "setRemoteDescription",
    ]);
    // the SFU answer was applied
    expect(port.last().remoteDescription).toEqual({ type: "answer", sdp: "sfu-answer" });
    // publish reported the negotiated mid + track name to the signal
    expect(signal.published[0]?.tracks).toEqual([{ mid: "0", trackName: `mic:${USER}` }]);
  });

  it("mic transceiver has no sendEncodings", async () => {
    await connect();
    await session.publishMic(fakeTrack("audio"));
    expect(port.last().transceivers[0]?.init).toEqual({ direction: "sendonly" });
    expect(port.last().transceivers[0]?.init.sendEncodings).toBeUndefined();
  });

  it("sequential publishes serialize on the queue (no interleaved createOffer)", async () => {
    await connect();
    await Promise.all([
      session.publishMic(fakeTrack("audio")),
      session.publishCam(fakeTrack("video")),
    ]);
    // two complete offer cycles back-to-back — never two createOffer before a setRemoteDescription
    expect(log.entries).toEqual([
      "addTransceiver",
      "createOffer",
      "setLocalDescription",
      "publishTracks",
      "setRemoteDescription",
      "addTransceiver",
      "createOffer",
      "setLocalDescription",
      "publishTracks",
      "setRemoteDescription",
    ]);
  });
});

describe("FR-27 simulcast encodings", () => {
  const cases: { preset: PresetId; h: RTCRtpEncodingParameters; scale: number }[] = [
    {
      preset: "1080p30",
      h: { rid: "h", maxBitrate: 2_000_000, maxFramerate: 30 },
      scale: 1080 / 270,
    },
    { preset: "480p15", h: { rid: "h", maxBitrate: 400_000, maxFramerate: 15 }, scale: 480 / 270 },
    {
      preset: "1440p60",
      h: { rid: "h", maxBitrate: 4_500_000, maxFramerate: 60 },
      scale: 1440 / 270,
    },
  ];

  for (const c of cases) {
    it(`${c.preset} → exact App-D h/l encodings`, async () => {
      await connect();
      await session.publishStream(fakeTrack("video"), null, c.preset);
      expect(port.last().transceivers[0]?.init.sendEncodings).toEqual([
        c.h,
        { rid: "l", maxBitrate: 250_000, maxFramerate: 15, scaleResolutionDownBy: c.scale },
      ]);
    });
  }

  it("publishStream with audio adds a screenAudio track with no encodings", async () => {
    await connect();
    const result = await session.publishStream(fakeTrack("video"), fakeTrack("audio"), "1080p30");
    expect(result).toEqual({
      videoTrackName: `screen:${USER}:1`,
      audioTrackName: `screenAudio:${USER}:1`,
    });
    const [video, audio] = port.last().transceivers;
    expect(video?.init.sendEncodings).toBeDefined();
    expect(audio?.init.sendEncodings).toBeUndefined();
    // both published in ONE renegotiation (single createOffer)
    expect(log.entries.filter((e) => e === "createOffer")).toHaveLength(1);
  });

  it("webcam publishes an h+l simulcast pair (App-D fixed 720p30)", async () => {
    await connect();
    await session.publishCam(fakeTrack("video"));
    expect(port.last().transceivers[0]?.init.sendEncodings).toEqual([
      { rid: "h", maxBitrate: 1_000_000, maxFramerate: 30 },
      { rid: "l", maxBitrate: 150_000, maxFramerate: 15, scaleResolutionDownBy: 720 / 180 },
    ]);
  });
});

describe("FR-27 setPreset", () => {
  it("applies applyConstraints + setParameters, createOffer NEVER called", async () => {
    await connect();
    const video = fakeTrack("video");
    const { videoTrackName } = await session.publishStream(video, null, "1080p30");
    log.clear();

    await session.setPreset(videoTrackName, "480p15");

    expect(video.applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 854, max: 854 },
      height: { ideal: 480, max: 480 },
      frameRate: { ideal: 15, max: 15 },
    });
    const sender = port.last().transceivers[0]?.sender;
    expect(sender?.setParametersCount).toBe(1);
    // the h encoding's ceiling was re-priced to the new preset; NO SDP op happened
    expect(sender?.encodings[0]).toMatchObject({ rid: "h", maxBitrate: 400_000, maxFramerate: 15 });
    expect(log.entries).not.toContain("createOffer");
    expect(log.entries).not.toContain("setLocalDescription");
  });
});

describe("FR-26 mute", () => {
  it("setTrackEnabled(false) disables the track and never calls replaceTrack(null)", async () => {
    await connect();
    const mic = fakeTrack("audio");
    const { trackName } = await session.publishMic(mic);

    session.setTrackEnabled(trackName, false);

    expect(mic.enabled).toBe(false);
    expect(port.last().transceivers[0]?.sender.replaceTrackArgs).toHaveLength(0);
  });
});

describe("PublishSession lifecycle", () => {
  it("unpublish stops the transceivers and closes the tracks (force close)", async () => {
    await connect();
    const { trackName } = await session.publishMic(fakeTrack("audio"));
    const transceiver = port.last().transceivers[0];

    await session.unpublish([trackName]);

    expect(transceiver?.stopped).toBe(true);
    expect(signal.closedTracks).toEqual([{ mids: ["0"] }]);
    // a later setTrackEnabled on an unpublished track is a no-op (sender gone)
    session.setTrackEnabled(trackName, false);
  });

  it("close() tears down the peer connection and reports 'closed'", async () => {
    const states: string[] = [];
    session.onStateChange((s) => states.push(s));
    await connect();
    await session.publishMic(fakeTrack("audio"));
    await session.close();
    expect(port.last().closed).toBe(true);
    expect(session.state).toBe("closed");
    expect(states).toContain("closed");
  });

  it("connect() surfaces a 'failed' state when signalling rejects", async () => {
    vi.spyOn(signal, "newSession").mockRejectedValueOnce(new Error("boom"));
    await expect(session.connect()).rejects.toThrow("boom");
    expect(session.state).toBe("failed");
  });

  it("a failed peer connection transitions the session to 'failed'", async () => {
    await connect();
    port.last().setConnectionState("failed");
    expect(session.state).toBe("failed");
  });
});
