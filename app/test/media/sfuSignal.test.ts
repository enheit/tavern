import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/apiClient";
import { createSfuSignal } from "@/media/sfuSignal";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function calls(mock: ReturnType<typeof vi.fn>): Call[] {
  return mock.mock.calls.map((c) => {
    const init = c[1] as { method: string; body?: string };
    return {
      url: String(c[0]),
      method: init.method,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const offer: RTCSessionDescriptionInit = { type: "offer", sdp: "o" };
const answer: RTCSessionDescriptionInit = { type: "answer", sdp: "a" };

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    let body: unknown = {};
    if (u.includes("/session")) body = { sessionId: "s1" };
    else if (u.includes("/tracks?")) body = { requiresImmediateRenegotiation: false, tracks: [] };
    else if (u.includes("/close?")) body = { requiresImmediateRenegotiation: false, tracks: [] };
    else if (u.includes("/ice"))
      body = { iceServers: [{ urls: "stun:x", username: "u", credential: "c" }] };
    return { ok: true, status: 200, headers: new Headers(), json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("§6.1 sfuSignal routes", () => {
  it("newSession POSTs the session route", async () => {
    const signal = createSfuSignal(apiClient);
    const result = await signal.newSession("srv");
    expect(result).toEqual({ sessionId: "s1" });
    expect(calls(fetchMock)[0]).toMatchObject({
      url: "/api/rtc/srv/session",
      method: "POST",
    });
  });

  it("publishTracks POSTs a local offer + tracks tagged with the puller session", async () => {
    const signal = createSfuSignal(apiClient);
    await signal.publishTracks("srv", "sess", offer, [{ mid: "0", trackName: "mic:u1" }]);
    const call = calls(fetchMock)[0];
    expect(call?.url).toBe("/api/rtc/srv/tracks?session=sess");
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({
      sessionDescription: offer,
      tracks: [{ location: "local", mid: "0", trackName: "mic:u1" }],
    });
  });

  it("pullTracks POSTs remote tracks, adding simulcast only when a rid is requested", async () => {
    const signal = createSfuSignal(apiClient);
    await signal.pullTracks("srv", "sess", [
      { trackName: "cam:u2", preferredRid: "l" },
      { trackName: "mic:u2" },
    ]);
    expect(calls(fetchMock)[0]?.body).toEqual({
      tracks: [
        { location: "remote", trackName: "cam:u2", simulcast: { preferredRid: "l" } },
        { location: "remote", trackName: "mic:u2" },
      ],
    });
  });

  it("renegotiate PUTs the answer", async () => {
    const signal = createSfuSignal(apiClient);
    await signal.renegotiate("srv", "sess", answer);
    expect(calls(fetchMock)[0]).toEqual({
      url: "/api/rtc/srv/renegotiate?session=sess",
      method: "PUT",
      body: { sessionDescription: answer },
    });
  });

  it("updateLayer PUTs the tracks/update route with the mid + trackName + preferredRid", async () => {
    const signal = createSfuSignal(apiClient);
    await signal.updateLayer("srv", "sess", "3", "screen:pub:1", "h");
    expect(calls(fetchMock)[0]).toEqual({
      url: "/api/rtc/srv/tracks/update?session=sess",
      method: "PUT",
      body: { tracks: [{ mid: "3", trackName: "screen:pub:1", simulcast: { preferredRid: "h" } }] },
    });
  });

  it("closeTracks force-closes without an offer, or sends a fresh offer when given", async () => {
    const signal = createSfuSignal(apiClient);
    await signal.closeTracks("srv", "sess", ["0", "1"]);
    expect(calls(fetchMock)[0]).toEqual({
      url: "/api/rtc/srv/close?session=sess",
      method: "POST",
      body: { tracks: [{ mid: "0" }, { mid: "1" }], force: true },
    });

    fetchMock.mockClear();
    await signal.closeTracks("srv", "sess", ["0"], offer);
    expect(calls(fetchMock)[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: false,
      sessionDescription: offer,
    });
  });

  it("getIceServers unwraps and shares one cached request across signal instances", async () => {
    const signal = createSfuSignal(apiClient);
    const other = createSfuSignal(apiClient);
    const [servers, cached] = await Promise.all([signal.getIceServers(), other.getIceServers()]);
    expect(servers).toEqual([{ urls: "stun:x", username: "u", credential: "c" }]);
    expect(cached).toEqual(servers);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls(fetchMock)[0]).toMatchObject({ url: "/api/rtc/ice", method: "GET" });
  });
});
