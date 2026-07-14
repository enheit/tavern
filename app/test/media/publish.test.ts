import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PresetId } from "@tavern/shared";
import { PublishSession, withOpusMaxAverageBitrate } from "@/media/rtc/publishSession";
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

  it("does not advertise a v2 publication until the browser peer connection is connected", async () => {
    await connect();
    signal.publishResponse = {
      requiresImmediateRenegotiation: false,
      publicationId: "00000000-0000-4000-8000-000000000001",
      tracks: [],
      sessionDescription: { type: "answer", sdp: "sfu-answer" },
    };
    const publishing = session.publishMic(fakeTrack("audio"));
    await vi.waitFor(() => expect(port.last().remoteDescription).not.toBeNull());
    expect(signal.confirmedPublications).toEqual([]);
    port.last().setConnectionState("connected");
    await publishing;
    expect(signal.confirmedPublications).toEqual(["00000000-0000-4000-8000-000000000001"]);
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
  // fakeTrack has no getSettings → acquisition height falls back to the preset height.
  const cases: { preset: PresetId; encodings: RTCRtpEncodingParameters[] }[] = [
    {
      preset: "1080p30",
      encodings: [
        { rid: "h", maxBitrate: 3_500_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
        { rid: "i", maxBitrate: 1_225_000, maxFramerate: 30, scaleResolutionDownBy: 2 },
        { rid: "l", maxBitrate: 350_000, maxFramerate: 30, scaleResolutionDownBy: 4 },
      ],
    },
    {
      preset: "480p15",
      encodings: [
        { rid: "h", maxBitrate: 400_000, maxFramerate: 15, scaleResolutionDownBy: 1 },
        { rid: "i", maxBitrate: 150_000, maxFramerate: 15, scaleResolutionDownBy: 2 },
        { rid: "l", maxBitrate: 100_000, maxFramerate: 15, scaleResolutionDownBy: 480 / 180 },
      ],
    },
    {
      preset: "1440p60",
      encodings: [
        { rid: "h", maxBitrate: 9_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 },
        { rid: "i", maxBitrate: 3_150_000, maxFramerate: 60, scaleResolutionDownBy: 2 },
        { rid: "l", maxBitrate: 900_000, maxFramerate: 30, scaleResolutionDownBy: 4 },
      ],
    },
  ];

  for (const c of cases) {
    it(`${c.preset} → exact h/i/l encodings`, async () => {
      await connect();
      const track = fakeTrack("video");
      const result = await session.publishStream(track, null, c.preset);
      expect(port.last().transceivers[0]?.init.sendEncodings).toEqual(c.encodings);
      expect(signal.published[0]?.tracks).toEqual([
        {
          mid: "0",
          trackName: result.videoTrackName,
          preset: c.preset,
          simulcastProfile: "h_i_l_v2",
        },
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

  it("webcam publishes an h+i+l simulcast ladder (fixed 720p30)", async () => {
    await connect();
    await session.publishCam(fakeTrack("video"));
    expect(port.last().transceivers[0]?.init.sendEncodings).toEqual([
      { rid: "h", maxBitrate: 1_000_000, maxFramerate: 30 },
      { rid: "i", maxBitrate: 350_000, maxFramerate: 30, scaleResolutionDownBy: 2 },
      { rid: "l", maxBitrate: 150_000, maxFramerate: 15, scaleResolutionDownBy: 720 / 180 },
    ]);
  });

  it("returns the confirmed RTC publication id to video preview owners", async () => {
    await connect();
    const publicationId = "00000000-0000-4000-8000-000000000001";
    signal.publishResponse = { ...signal.publishResponse, publicationId };
    port.last().setConnectionState("connected");

    await expect(session.publishCam(fakeTrack("video"))).resolves.toEqual({
      trackName: `cam:${USER}`,
      previewId: publicationId,
    });
  });
});

describe("FR-27 setPreset", () => {
  it("changes encoder policy without capture constraint churn or renegotiation", async () => {
    await connect();
    const video = fakeTrack("video");
    const { videoTrackName } = await session.publishStream(video, null, "1080p30");
    log.clear();

    await session.setPreset(videoTrackName, "480p15");

    expect(video.applyConstraints).not.toHaveBeenCalled();
    const sender = port.last().transceivers[0]?.sender;
    expect(sender?.setParametersCount).toBe(1);
    // All three layers are re-derived from the immutable 1080 acquisition geometry.
    expect(sender?.encodings[0]).toMatchObject({
      rid: "h",
      maxBitrate: 400_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 1080 / 480,
    });
    expect(sender?.encodings[1]).toMatchObject({
      rid: "i",
      maxBitrate: 150_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 1080 / 240,
    });
    expect(sender?.encodings[2]).toMatchObject({
      rid: "l",
      maxBitrate: 100_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 1080 / 180,
    });
    expect(sender?.degradationPreference).toBe("maintain-resolution");
    expect(video.contentHint).toBe("detail");
    expect(log.entries).not.toContain("createOffer");
    expect(log.entries).not.toContain("setLocalDescription");
  });

  it("replaces an upward capture on the existing sender and rolls back on parameter failure", async () => {
    await connect();
    const oldTrack = fakeTrack("video");
    const { videoTrackName } = await session.publishStream(oldTrack, null, "1080p30");
    const sender = port.last().transceivers[0]?.sender;
    if (!sender) throw new Error("video sender missing");
    const nextTrack = fakeTrack("video");
    vi.spyOn(sender, "setParameters").mockRejectedValueOnce(new Error("encoder rejected"));

    await expect(session.replaceScreenTrack(videoTrackName, nextTrack, "1080p60")).rejects.toThrow(
      "encoder rejected",
    );

    expect(sender.replaceTrackArgs).toEqual([nextTrack, oldTrack]);
    expect(sender.track).toBe(oldTrack);
    expect(signal.published).toHaveLength(1);
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

  it("requests a rebuild after disconnected reconnects without reaching failed", async () => {
    await connect();
    const recoveryNeeded = vi.fn();
    session.onConnectionRecoveryNeeded(recoveryNeeded);

    port.last().setConnectionState("disconnected");
    expect(recoveryNeeded).not.toHaveBeenCalled();
    port.last().setConnectionState("connected");
    expect(recoveryNeeded).toHaveBeenCalledTimes(1);
  });
});

// Task-2 (d): the published mic targets Opus 64 kbps — fmtp maxaveragebitrate in the applied
// answer raises the encoder target; sender maxBitrate caps it to the same figure.
describe("Task-2 mic Opus bitrate", () => {
  const MIC_ANSWER_SDP = [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    "a=recvonly",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    "",
  ].join("\r\n");

  it("publishMic munges the applied answer's opus fmtp and caps the sender", async () => {
    await connect();
    signal.publishResponse = {
      requiresImmediateRenegotiation: false,
      tracks: [],
      sessionDescription: { type: "answer", sdp: MIC_ANSWER_SDP },
    };

    await session.publishMic(fakeTrack("audio"));

    const applied = port.last().remoteDescription?.sdp ?? "";
    expect(applied).toContain("a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000");
    const sender = port.last().transceivers[0]?.sender;
    expect(sender?.encodings[0]?.maxBitrate).toBe(64_000);
    expect(sender?.setParametersCount).toBe(1);
  });

  it("screen/cam publishes keep their answer untouched (no mic bitrate hint)", async () => {
    await connect();
    signal.publishResponse = {
      requiresImmediateRenegotiation: false,
      tracks: [],
      sessionDescription: { type: "answer", sdp: MIC_ANSWER_SDP },
    };
    await session.publishCam(fakeTrack("video"));
    expect(port.last().remoteDescription?.sdp).toBe(MIC_ANSWER_SDP);
  });
});

describe("withOpusMaxAverageBitrate", () => {
  const base = [
    "v=0",
    "s=-",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=mid:0",
    "a=rtpmap:96 VP8/90000",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=mid:1",
    "a=rtpmap:111 opus/48000/2",
    "",
  ].join("\r\n");

  it("inserts a new fmtp after the rtpmap when none exists (video sections skipped)", () => {
    const out = withOpusMaxAverageBitrate(base, "1", 64_000);
    expect(out).toContain("a=rtpmap:111 opus/48000/2\r\na=fmtp:111 maxaveragebitrate=64000");
    expect(out).not.toContain("a=fmtp:96");
  });

  it("replaces an existing maxaveragebitrate in place", () => {
    const withRate = base.replace(
      "a=rtpmap:111 opus/48000/2",
      "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 maxaveragebitrate=32000;useinbandfec=1",
    );
    const out = withOpusMaxAverageBitrate(withRate, "1", 64_000);
    expect(out).toContain("a=fmtp:111 maxaveragebitrate=64000;useinbandfec=1");
    expect(out).not.toContain("32000");
  });

  it("returns the SDP untouched for an unknown mid or a non-SDP string", () => {
    expect(withOpusMaxAverageBitrate(base, "9", 64_000)).toBe(base);
    expect(withOpusMaxAverageBitrate("sfu-answer", "0", 64_000)).toBe("sfu-answer");
  });
});
