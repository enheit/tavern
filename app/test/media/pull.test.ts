import { beforeEach, describe, expect, it } from "vitest";
import { PullSession } from "@/media/rtc/pullSession";
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

  it("preferredRid is forwarded on the initial pull", async () => {
    await connect();
    await session.addRemoteTracks([{ trackName: "mic:u2", preferredRid: "l" }]);
    expect(signal.pulled[0]?.tracks).toEqual([{ trackName: "mic:u2", preferredRid: "l" }]);
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
