import { beforeEach, describe, expect, it, vi } from "vitest";
import { PullSession, PullTracksError } from "@/media/rtc/pullSession";
import { EventLog } from "../fakes/log";
import { fakeStream, fakeTrack } from "../fakes/media";
import { FakeRtcPort } from "../fakes/rtc";
import { FakeSignal } from "../fakes/signal";

let log: EventLog;
let port: FakeRtcPort;
let signal: FakeSignal;
let session: PullSession;

async function connect(): Promise<void> {
  await session.connect();
  log.clear();
}

beforeEach(() => {
  log = new EventLog();
  port = new FakeRtcPort(log);
  signal = new FakeSignal(log);
  // The SFU maps the pulled track to a negotiated mid in its tracks response.
  signal.pullResponse = {
    requiresImmediateRenegotiation: true,
    tracks: [{ trackName: "mic:u2", mid: "0" }],
    sessionDescription: { type: "offer", sdp: "sfu-offer" },
  };
  session = new PullSession({ rtc: port, signal, serverId: "srv" });
});

describe("FR-19 pull flow", () => {
  it("answers the SFU offer then renegotiates (order asserted)", async () => {
    await connect();
    await session.addRemoteTracks([{ trackName: "mic:u2" }]);
    // pull → SFU offers → setRemote(offer) → createAnswer → setLocal → PUT renegotiate
    expect(log.entries).toEqual([
      "pullTracks",
      "setRemoteDescription",
      "createAnswer",
      "setLocalDescription",
      "renegotiate",
    ]);
    expect(port.last().remoteDescription).toEqual({ type: "offer", sdp: "sfu-offer" });
    expect(signal.renegotiated[0]).toEqual({ type: "answer", sdp: "fake-answer" });
    expect(session.state).toBe("connected");
  });

  it("emits onTrack for a pulled track keyed by its negotiated mid", async () => {
    const received: { trackName: string; track: MediaStreamTrack; stream: MediaStream }[] = [];
    session.onTrack((trackName, track, stream) => received.push({ trackName, track, stream }));
    await connect();
    await session.addRemoteTracks([{ trackName: "mic:u2" }]);

    const track = fakeTrack("audio");
    const stream = fakeStream({ audio: [track] });
    port.last().emitTrack("0", track, stream);

    expect(received).toEqual([{ trackName: "mic:u2", track, stream }]);
    // an unknown mid is ignored (no mapping)
    port.last().emitTrack("99", fakeTrack("audio"), fakeStream());
    expect(received).toHaveLength(1);
  });

  it("add/remove remote tracks serialize on the queue", async () => {
    await connect();
    await Promise.all([
      session.addRemoteTracks([{ trackName: "mic:u2" }]),
      session.removeRemoteTracks(["mic:u2"]),
    ]);
    // removal ran AFTER the add fully populated the mid map, so it could resolve the mid
    expect(signal.closedTracks).toEqual([{ mids: ["0"] }]);
    const addIdx = log.entries.indexOf("renegotiate");
    const removeIdx = log.entries.indexOf("closeTracks");
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(addIdx);
  });

  it("answers an immediate SFU offer before releasing a closed remote-track mapping", async () => {
    await connect();
    await session.addRemoteTracks([{ trackName: "mic:u2" }]);
    signal.closeResponse = {
      requiresImmediateRenegotiation: true,
      tracks: [],
      sessionDescription: { type: "offer", sdp: "close-offer" },
    };
    log.clear();

    await session.removeRemoteTracks(["mic:u2"]);

    expect(log.entries).toEqual([
      "closeTracks",
      "setRemoteDescription",
      "createAnswer",
      "setLocalDescription",
      "renegotiate",
    ]);
    expect(port.last().remoteDescription).toEqual({ type: "offer", sdp: "close-offer" });
    await expect(session.setLayer("mic:u2", "h")).rejects.toThrow("no pulled track");
  });

  it("preferredRid is forwarded on the initial pull", async () => {
    await connect();
    await session.addRemoteTracks([{ trackName: "mic:u2", preferredRid: "l" }]);
    expect(signal.pulled[0]?.tracks).toEqual([{ trackName: "mic:u2", preferredRid: "l" }]);
  });
});

// TASK-1 (D1): the SFU answers 200 with PER-TRACK errors when a pull races the publisher's own
// registration. Swallowing them (pre-fix) marked the pull successful — no retry, permanent silence.
describe("per-track pull errors", () => {
  it("a pull whose only track errors throws PullTracksError (callers retry)", async () => {
    await connect();
    signal.pullResponse = {
      requiresImmediateRenegotiation: false,
      tracks: [
        { trackName: "mic:u2", error: { code: "track_not_found", message: "no such track" } },
      ],
    };
    await expect(session.addRemoteTracks([{ trackName: "mic:u2" }])).rejects.toBeInstanceOf(
      PullTracksError,
    );
    await expect(
      session.addRemoteTracks([{ trackName: "mic:u2" }]).catch((err: unknown) => {
        if (err instanceof PullTracksError) return err.failed;
        throw err;
      }),
    ).resolves.toEqual(["mic:u2"]);
    // No SFU offer came back → nothing to renegotiate.
    expect(log.entries).not.toContain("setRemoteDescription");
  });

  it("a partial failure renegotiates the successful track FIRST, then throws with the failed names", async () => {
    await connect();
    signal.pullResponse = {
      requiresImmediateRenegotiation: true,
      tracks: [
        { trackName: "screen:u2:1", mid: "0" },
        { trackName: "screenAudio:u2:1", error: { code: "track_not_found", message: "gone" } },
      ],
      sessionDescription: { type: "offer", sdp: "sfu-offer" },
    };
    const err = await session
      .addRemoteTracks([{ trackName: "screen:u2:1" }, { trackName: "screenAudio:u2:1" }])
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(PullTracksError);
    if (err instanceof PullTracksError) expect(err.failed).toEqual(["screenAudio:u2:1"]);
    // The successful m-line was renegotiated before the throw (an unanswered
    // requiresImmediateRenegotiation kills the session — §7.1).
    expect(log.entries).toEqual([
      "pullTracks",
      "setRemoteDescription",
      "createAnswer",
      "setLocalDescription",
      "renegotiate",
    ]);
    // …and the successful track is wired: its track event still maps.
    const received: string[] = [];
    session.onTrack((trackName) => received.push(trackName));
    port.last().emitTrack("0", fakeTrack("video"), fakeStream());
    expect(received).toEqual(["screen:u2:1"]);
  });

  it("a track with neither mid nor error is treated as failed", async () => {
    await connect();
    signal.pullResponse = {
      requiresImmediateRenegotiation: false,
      tracks: [{ trackName: "mic:u2" }],
    };
    await expect(session.addRemoteTracks([{ trackName: "mic:u2" }])).rejects.toBeInstanceOf(
      PullTracksError,
    );
  });
});

describe("per-track inbound audio stats", () => {
  it("keys inbound-rtp audio bytes by pulled trackName via the mid map", async () => {
    await connect();
    signal.pullResponse = {
      requiresImmediateRenegotiation: true,
      tracks: [
        { trackName: "mic:u2", mid: "0" },
        { trackName: "mic:u3", mid: "1" },
      ],
      sessionDescription: { type: "offer", sdp: "sfu-offer" },
    };
    await session.addRemoteTracks([{ trackName: "mic:u2" }, { trackName: "mic:u3" }]);
    port.last().statsReport = [
      { type: "inbound-rtp", kind: "audio", mid: "0", bytesReceived: 111 },
      { type: "inbound-rtp", kind: "audio", mid: "1", bytesReceived: 222 },
      { type: "inbound-rtp", kind: "video", mid: "9", bytesReceived: 999 }, // ignored
      { type: "outbound-rtp", kind: "audio", mid: "0", bytesReceived: 5 }, // ignored
    ];
    await expect(session.inboundAudioBytesByTrack()).resolves.toEqual({
      "mic:u2": 111,
      "mic:u3": 222,
    });
  });
});

describe("transport recovery signal", () => {
  it("fires on terminal failure and unsubscribes cleanly", async () => {
    await connect();
    const failed = vi.fn();
    const unsub = session.onConnectionRecoveryNeeded(failed);
    port.last().setConnectionState("failed");
    expect(failed).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("failed");
    unsub();
    port.last().setConnectionState("failed");
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("fires after disconnected reconnects without ever reaching failed", async () => {
    await connect();
    const recovered = vi.fn();
    session.onConnectionRecoveryNeeded(recovered);

    port.last().setConnectionState("disconnected");
    expect(recovered).not.toHaveBeenCalled();
    port.last().setConnectionState("connected");
    expect(recovered).toHaveBeenCalledTimes(1);

    // Ordinary connected notifications do not rebuild a healthy session.
    port.last().setConnectionState("connected");
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});

describe("FR-33 layer", () => {
  it("setLayer → updateLayer with the mid, no SDP op", async () => {
    await connect();
    await session.addRemoteTracks([{ trackName: "mic:u2" }]);
    log.clear();

    await session.setLayer("mic:u2", "h");

    expect(signal.layerUpdates).toEqual([{ mid: "0", rid: "h" }]);
    expect(log.entries).toEqual(["updateLayer"]); // no setRemoteDescription/createAnswer/setLocal
  });

  it("setLayer on an un-pulled track throws", async () => {
    await connect();
    await expect(session.setLayer("cam:nobody", "h")).rejects.toThrow("no pulled track");
  });
});

describe("PullSession lifecycle", () => {
  it("close() tears down the peer connection and reports 'closed'", async () => {
    await connect();
    await session.addRemoteTracks([{ trackName: "mic:u2" }]);
    await session.close();
    expect(port.last().closed).toBe(true);
    expect(session.state).toBe("closed");
  });

  it("connect() surfaces 'failed' when signalling rejects and on a failed connection", async () => {
    const failing = new FakeSignal(log);
    failing.getIceServers = () => Promise.reject(new Error("ice down"));
    const bad = new PullSession({ rtc: port, signal: failing, serverId: "srv" });
    await expect(bad.connect()).rejects.toThrow("ice down");
    expect(bad.state).toBe("failed");

    await connect();
    port.last().setConnectionState("failed");
    expect(session.state).toBe("failed");
  });
});
