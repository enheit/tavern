import { beforeEach, describe, expect, it } from "vitest";
import { createRealtimeMock, resetSfuMock } from "../src/rtc/realtimeMock";

// The mock SFU's live-signaling mirror (PLAN §10, TASK-1): per-track errors for unpublished names,
// per-session ACCUMULATED pull offers with mids matching the response, close → inactive. These are
// the behaviors the multi-client voice e2e leans on — a regression here silently un-tests it.

function offer(sdp = "v=0\r\na=setup:actpass\r\na=sendonly\r\n"): {
  sdp: string;
  type: "offer";
} {
  return { sdp, type: "offer" };
}

beforeEach(() => {
  resetSfuMock();
});

describe("mock SFU published-track mirror", () => {
  it("pulling an unpublished trackName → 200 with a per-track error, no SDP", async () => {
    const client = createRealtimeMock();
    const res = await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-sess", trackName: "mic:u1" },
    ]);
    expect(res.requiresImmediateRenegotiation).toBe(false);
    expect(res.sessionDescription).toBeUndefined();
    expect(res.tracks).toEqual([
      {
        trackName: "mic:u1",
        errorCode: "track_not_found",
        errorDescription: "mock: no live publisher for this trackName",
      },
    ]);
  });

  it("publish → pull succeeds; the offer carries the response mid + an msid", async () => {
    const client = createRealtimeMock();
    await client.newLocalTracks("pub-sess", offer(), [
      { location: "local", mid: "0", trackName: "mic:u1" },
    ]);
    const res = await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-sess", trackName: "mic:u1" },
    ]);
    expect(res.requiresImmediateRenegotiation).toBe(true);
    expect(res.tracks).toEqual([{ trackName: "mic:u1", mid: "0" }]);
    const sdp = res.sessionDescription?.sdp ?? "";
    expect(sdp).toContain("a=mid:0");
    expect(sdp).toContain("m=audio");
    expect(sdp).toContain("a=msid:");
    expect(sdp).not.toContain("a=candidate"); // ICE must never start checking in the mock
  });

  it("sequential pulls ACCUMULATE m-lines with distinct mids (multi-member voice)", async () => {
    const client = createRealtimeMock();
    await client.newLocalTracks("pub-1", offer(), [
      { location: "local", mid: "0", trackName: "mic:u1" },
    ]);
    await client.newLocalTracks("pub-2", offer(), [
      { location: "local", mid: "0", trackName: "mic:u2" },
    ]);
    const first = await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-1", trackName: "mic:u1" },
    ]);
    const second = await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-2", trackName: "mic:u2" },
    ]);
    expect(first.tracks).toEqual([{ trackName: "mic:u1", mid: "0" }]);
    expect(second.tracks).toEqual([{ trackName: "mic:u2", mid: "1" }]);
    const sdp = second.sessionDescription?.sdp ?? "";
    // The second offer still carries the FIRST m-line (JSEP m-line order is immutable) + BUNDLEs both.
    expect(sdp).toContain("a=group:BUNDLE 0 1");
    expect(sdp.match(/m=audio/g)).toHaveLength(2);
    expect(sdp).toContain("a=mid:0");
    expect(sdp).toContain("a=mid:1");
  });

  it("mixed kinds: screen pulls build video m-lines, screenAudio audio m-lines", async () => {
    const client = createRealtimeMock();
    await client.newLocalTracks("pub-1", offer(), [
      { location: "local", mid: "0", trackName: "screen:u1:1" },
      { location: "local", mid: "1", trackName: "screenAudio:u1:1" },
    ]);
    const res = await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-1", trackName: "screen:u1:1" },
      { location: "remote", sessionId: "pub-1", trackName: "screenAudio:u1:1" },
    ]);
    const sdp = res.sessionDescription?.sdp ?? "";
    expect(sdp.match(/m=video/g)).toHaveLength(1);
    expect(sdp.match(/m=audio/g)).toHaveLength(1);
  });

  it("partial failure: known + unknown in one pull → one mid, one error, SDP for the known", async () => {
    const client = createRealtimeMock();
    await client.newLocalTracks("pub-1", offer(), [
      { location: "local", mid: "0", trackName: "mic:u1" },
    ]);
    const res = await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-1", trackName: "mic:u1" },
      { location: "remote", sessionId: "pub-x", trackName: "mic:ghost" },
    ]);
    expect(res.requiresImmediateRenegotiation).toBe(true);
    expect(res.tracks).toHaveLength(2);
    expect(res.tracks[0]).toEqual({ trackName: "mic:u1", mid: "0" });
    expect(res.tracks[1]?.errorCode).toBe("track_not_found");
    expect(res.sessionDescription?.sdp).toContain("a=mid:0");
  });

  it("a closed pull m-line stays in later offers as inactive", async () => {
    const client = createRealtimeMock();
    await client.newLocalTracks("pub-1", offer(), [
      { location: "local", mid: "0", trackName: "mic:u1" },
    ]);
    await client.newLocalTracks("pub-2", offer(), [
      { location: "local", mid: "0", trackName: "mic:u2" },
    ]);
    await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-1", trackName: "mic:u1" },
    ]);
    await client.closeTracks("pull-sess", ["0"], undefined, true);
    const next = await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-2", trackName: "mic:u2" },
    ]);
    const sdp = next.sessionDescription?.sdp ?? "";
    const lines = sdp.split("\r\n");
    const firstMlineAt = lines.indexOf("m=audio 9 UDP/TLS/RTP/SAVPF 111");
    expect(firstMlineAt).toBeGreaterThan(-1);
    // the first (closed) m-line reads inactive; the new one sendonly
    expect(sdp).toContain("a=inactive");
    expect(sdp).toContain("a=sendonly");
  });

  it("a publisher closing its mid unregisters the name — later pulls error (dead-session mirror)", async () => {
    const client = createRealtimeMock();
    await client.newLocalTracks("pub-1", offer(), [
      { location: "local", mid: "0", trackName: "mic:u1" },
    ]);
    await client.closeTracks("pub-1", ["0"], undefined, true);
    const res = await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-1", trackName: "mic:u1" },
    ]);
    expect(res.tracks[0]?.errorCode).toBe("track_not_found");
  });

  it("a re-publish under the same name replaces the owner — the name stays pullable", async () => {
    const client = createRealtimeMock();
    await client.newLocalTracks("pub-old", offer(), [
      { location: "local", mid: "0", trackName: "mic:u1" },
    ]);
    // rejoin: same trackName, NEW session (the old one is dead but never explicitly closed)
    await client.newLocalTracks("pub-new", offer(), [
      { location: "local", mid: "0", trackName: "mic:u1" },
    ]);
    // the old session's late close must NOT take the re-published name off the registry
    await client.closeTracks("pub-old", ["0"], undefined, true);
    const res = await client.newRemoteTracks("pull-sess", [
      { location: "remote", sessionId: "pub-new", trackName: "mic:u1" },
    ]);
    expect(res.tracks).toEqual([{ trackName: "mic:u1", mid: "0" }]);
  });
});
