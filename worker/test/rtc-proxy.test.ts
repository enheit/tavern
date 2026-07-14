import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomState } from "../src/do/roomState";
import type { RtcRegistry } from "../src/do/roomState";
import { RealtimeError, createRealtimeClient } from "../src/rtc/realtime";
import { resetSfuMock, sfuMockCalls } from "../src/rtc/realtimeMock";
import { fetchTurnIceServers } from "../src/routes/rtc";

const BASE = "https://tavern.test";

type RoomStub = DurableObjectStub<import("../src/do/ServerRoom").ServerRoom>;

// Non-null narrow without `!` (§9.1).
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

async function register(username: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
  if (!res.ok) throw new Error(`register ${username} failed: ${res.status} ${await res.text()}`);
  return must(res.headers.get("set-auth-token"), `no set-auth-token for ${username}`);
}

function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

async function meUserId(token: string): Promise<string> {
  const body: { user: { userId: string } } = await (await authed(token, "/api/me")).json();
  return body.user.userId;
}

async function createServer(token: string, nickname: string): Promise<string> {
  // Creation now requires a password + a one-time operator-seeded code (migration 0003); seed a fresh
  // code per create and use a fixed password.
  const code = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO server_creation_codes (code, created_at) VALUES (?, ?)")
    .bind(code, Date.now())
    .run();
  const res = await authed(token, "/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname, password: "hunter2", code }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const summary: { id: string } = await res.json();
  return summary.id;
}

function roomStub(serverId: string): RoomStub {
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
}

// Seed voice membership straight into DO KV (the default project cannot drive DO WebSockets, so a
// voice.join is unavailable here — the rtcAuthorize path re-reads `voice` from KV, S3.1 known-issue pin).
async function seedVoice(serverId: string, userIds: string[]): Promise<void> {
  await runInDurableObject(roomStub(serverId), async (_i, state) => {
    await state.storage.put("voice", {
      members: userIds.map((userId) => ({
        userId,
        muted: false,
        deafened: false,
        micSeq: 0,
        mediaReadyVersion: 2,
      })),
      sessionStartedAt: Date.now(),
    });
  });
}

async function seedRegistry(serverId: string, reg: RtcRegistry): Promise<void> {
  await runInDurableObject(roomStub(serverId), async (_i, state) => {
    await state.storage.put("rtc", reg);
  });
}

async function readRegistry(serverId: string): Promise<RtcRegistry> {
  return runInDurableObject(roomStub(serverId), async (_i, state) => {
    return new RoomState(state, env).rtcSnapshot();
  });
}

const OFFER = { type: "offer" as const, sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n" };

function publishBody(mid: string, trackName: string): unknown {
  return { sessionDescription: OFFER, tracks: [{ location: "local", mid, trackName }] };
}

function rtcPost(token: string, serverId: string, sub: string, body: unknown): Promise<Response> {
  return authed(token, `/api/rtc/${serverId}/${sub}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function newSession(token: string, serverId: string): Promise<string> {
  const res = await rtcPost(token, serverId, "session", { mediaReadyVersion: 2 });
  if (res.status !== 200) throw new Error(`session failed: ${res.status} ${await res.text()}`);
  const body: { sessionId: string } = await res.json();
  return body.sessionId;
}

beforeEach(() => {
  resetSfuMock();
});

describe("FR-19 rtc proxy auth", () => {
  it("non-member → 403 forbidden", async () => {
    const owner = await register("rtc_owner_a");
    const serverId = await createServer(owner, "rtc-auth-a");
    const outsider = await register("rtc_outsider_a");

    const res = await rtcPost(outsider, serverId, "session", { mediaReadyVersion: 2 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("member not in voice → not_in_voice", async () => {
    const owner = await register("rtc_owner_b");
    const serverId = await createServer(owner, "rtc-auth-b");

    const res = await rtcPost(owner, serverId, "session", { mediaReadyVersion: 2 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_in_voice" });
  });

  it("in voice → session.new returns a mock sessionId + registers it", async () => {
    const owner = await register("rtc_owner_c");
    const uid = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-auth-c");
    await seedVoice(serverId, [uid]);

    const res = await rtcPost(owner, serverId, "session", { mediaReadyVersion: 2 });
    expect(res.status).toBe(200);
    const body: { sessionId: string } = await res.json();
    expect(body.sessionId).toMatch(/^mock-sess-\d+$/);
    // The SFU session was created (POST) and the DO registered it to the caller.
    expect(sfuMockCalls.some((c) => c.op === "newSession" && c.method === "POST")).toBe(true);
    const reg = await readRegistry(serverId);
    expect(reg.sessions[body.sessionId]).toEqual({ userId: uid, mediaReadyVersion: 2 });
  });
});

describe("FR-19 publish registry", () => {
  it("readiness protocol keeps a newly published mic unpullable until browser confirmation", async () => {
    const owner = await register("rtc_ready_owner");
    const uid = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-ready");
    await seedVoice(serverId, [uid]);
    const sessionId = await newSession(owner, serverId);

    const published = await authed(owner, `/api/rtc/${serverId}/tracks?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publishBody("0", `mic:${uid}`)),
    });
    expect(published.status).toBe(200);
    const { publicationId } = (await published.json()) as { publicationId: string };
    expect(publicationId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readRegistry(serverId)).tracks[`mic:${uid}`]).toBeUndefined();

    const ready = await rtcPost(owner, serverId, `tracks/ready?session=${sessionId}`, {
      publicationId,
    });
    expect(ready.status).toBe(200);
    expect((await readRegistry(serverId)).tracks[`mic:${uid}`]).toMatchObject({
      userId: uid,
      sessionId,
      kind: "mic",
    });
  });

  it("confirmed mic:{uid} publish → the DO registry contains it", async () => {
    const owner = await register("rtc_pub_a");
    const uid = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-pub-a");
    await seedVoice(serverId, [uid]);
    const sessionId = await newSession(owner, serverId);

    const res = await authed(owner, `/api/rtc/${serverId}/tracks?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publishBody("0", `mic:${uid}`)),
    });
    expect(res.status).toBe(200);
    const { publicationId } = (await res.json()) as { publicationId: string };
    const ready = await rtcPost(owner, serverId, `tracks/ready?session=${sessionId}`, {
      publicationId,
    });
    expect(ready.status).toBe(200);

    const reg = await readRegistry(serverId);
    expect(reg.tracks[`mic:${uid}`]).toMatchObject({ userId: uid, sessionId, kind: "mic" });
  });

  it("registers the v2 screen profile but sends only the SFU track contract upstream", async () => {
    const owner = await register("rtc_pub_profile");
    const uid = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-pub-profile");
    await seedVoice(serverId, [uid]);
    const sessionId = await newSession(owner, serverId);
    resetSfuMock();
    const trackName = `screen:${uid}:1`;

    const res = await authed(owner, `/api/rtc/${serverId}/tracks?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionDescription: OFFER,
        tracks: [
          {
            location: "local",
            mid: "0",
            trackName,
            preset: "1080p60",
            simulcastProfile: "h_i_l_v2",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const { publicationId } = (await res.json()) as { publicationId: string };
    const ready = await rtcPost(owner, serverId, `tracks/ready?session=${sessionId}`, {
      publicationId,
    });
    expect(ready.status).toBe(200);
    expect((await readRegistry(serverId)).tracks[trackName]).toMatchObject({
      preset: "1080p60",
      simulcastProfile: "h_i_l_v2",
    });
    const call = must(
      sfuMockCalls.find((candidate) => candidate.op === "newLocalTracks"),
      "SFU publish call",
    );
    expect(call.payload).toMatchObject({
      tracks: [{ location: "local", mid: "0", trackName }],
    });
    expect(JSON.stringify(call.payload)).not.toContain("simulcastProfile");
    expect(JSON.stringify(call.payload)).not.toContain("1080p60");
  });

  it("bad track-name grammar → 400 bad_request (never reaches the SFU)", async () => {
    const owner = await register("rtc_pub_b");
    const uid = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-pub-b");
    await seedVoice(serverId, [uid]);
    const sessionId = await newSession(owner, serverId);
    resetSfuMock();

    const res = await authed(owner, `/api/rtc/${serverId}/tracks?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publishBody("0", "not-a-valid-track")),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
    expect(sfuMockCalls.some((c) => c.op === "newLocalTracks")).toBe(false);
  });

  it("foreign userId in the track name → 400 (a client may only publish its own tracks)", async () => {
    const owner = await register("rtc_pub_own");
    const uid = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-pub-own");
    await seedVoice(serverId, [uid]);
    const sessionId = await newSession(owner, serverId);

    const res = await authed(owner, `/api/rtc/${serverId}/tracks?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publishBody("0", `mic:${crypto.randomUUID()}`)),
    });
    expect(res.status).toBe(400);
  });

  it("5th concurrent screen:* publish → share_cap (G4)", async () => {
    const owner = await register("rtc_pub_c");
    const uid = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-pub-c");
    await seedVoice(serverId, [uid]);
    const sessionId = await newSession(owner, serverId);

    // Sequential: each publish reads-then-writes the registry, so the 4 must land before the 5th.
    const publishScreen = (n: number): Promise<Response> =>
      authed(owner, `/api/rtc/${serverId}/tracks?session=${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(publishBody(String(n), `screen:${uid}:${n}`)),
      });

    expect((await publishScreen(1)).status).toBe(200);
    expect((await publishScreen(2)).status).toBe(200);
    expect((await publishScreen(3)).status).toBe(200);
    expect((await publishScreen(4)).status).toBe(200);
    const fifth = await publishScreen(5);
    expect(fifth.status).toBe(403);
    expect(await fifth.json()).toEqual({ error: "share_cap" });
  });
});

describe("FR-30 pull grants", () => {
  // Seeds a published screen (by `publisher`) + a mic, on a known publisher session; `viewer` is a
  // member seeded into voice. Grants are added per-test.
  async function setupPull(
    serverId: string,
    viewerId: string,
    publisherId: string,
  ): Promise<{ screenTrack: string; micTrack: string; pubSession: string }> {
    const pubSession = "pub-sess-1";
    const screenTrack = `screen:${publisherId}:1`;
    const micTrack = `mic:${publisherId}`;
    await seedRegistry(serverId, {
      sessions: { [pubSession]: { userId: publisherId, mediaReadyVersion: 2 } },
      tracks: {
        [screenTrack]: {
          userId: publisherId,
          sessionId: pubSession,
          kind: "screen",
          preset: "1080p30",
        },
        [micTrack]: { userId: publisherId, sessionId: pubSession, kind: "mic" },
      },
      pending: {},
      grants: {},
      deliveries: {},
    });
    await seedVoice(serverId, [viewerId, publisherId]);
    return { screenTrack, micTrack, pubSession };
  }

  function pull(
    token: string,
    serverId: string,
    trackName: string,
    preferredRid?: "h" | "i" | "l",
  ): Promise<Response> {
    return authed(token, `/api/rtc/${serverId}/tracks?session=viewer-sess`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tracks: [
          {
            location: "remote",
            trackName,
            ...(preferredRid === undefined ? {} : { simulcast: { preferredRid } }),
          },
        ],
      }),
    });
  }

  it("pull of screen:* without a watch grant → pull_denied", async () => {
    const owner = await register("rtc_pull_a");
    const viewerId = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-pull-a");
    const { screenTrack } = await setupPull(serverId, viewerId, crypto.randomUUID());

    const res = await pull(owner, serverId, screenTrack);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "pull_denied" });
  });

  it("after a grant → ok, and the SFU is called with the resolved publisher session", async () => {
    const owner = await register("rtc_pull_b");
    const viewerId = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-pull-b");
    const { screenTrack, pubSession } = await setupPull(serverId, viewerId, crypto.randomUUID());
    await runInDurableObject(roomStub(serverId), async (_i, state) => {
      await new RoomState(state, env).rtcAddGrant(viewerId, screenTrack, "h");
    });
    expect((await readRegistry(serverId)).deliveries[viewerId]?.[screenTrack]).toBe("video");
    resetSfuMock();

    const res = await pull(owner, serverId, screenTrack);
    expect(res.status).toBe(200);
    const remote = must(
      sfuMockCalls.find((c) => c.op === "newRemoteTracks"),
      "SFU newRemoteTracks called",
    );
    // publisherSessions resolved the trackName → the publisher's sessionId (the client never sent it).
    expect(remote.payload).toMatchObject({
      tracks: [{ trackName: screenTrack, sessionId: pubSession }],
    });
    expect(JSON.stringify(remote.payload)).not.toContain("simulcast");
  });

  it("pins explicit simulcast requests for both legacy and v2 publishers", async () => {
    const owner = await register("rtc_pull_adapt");
    const viewerId = await meUserId(owner);
    const publisherId = crypto.randomUUID();
    const serverId = await createServer(owner, "rtc-pull-adapt");
    const { screenTrack } = await setupPull(serverId, viewerId, publisherId);
    await runInDurableObject(roomStub(serverId), async (_i, state) => {
      await new RoomState(state, env).rtcAddGrant(viewerId, screenTrack, "h");
    });
    resetSfuMock();

    expect((await pull(owner, serverId, screenTrack, "h")).status).toBe(200);
    const legacy = must(
      sfuMockCalls.find((call) => call.op === "newRemoteTracks"),
      "legacy pull",
    );
    expect(legacy.payload).toMatchObject({
      tracks: [
        {
          simulcast: {
            preferredRid: "h",
            priorityOrdering: "none",
            ridNotAvailable: "none",
          },
        },
      ],
    });

    const reg = await readRegistry(serverId);
    const registered = reg.tracks[screenTrack];
    if (registered === undefined) throw new Error("seeded screen missing");
    reg.tracks[screenTrack] = { ...registered, simulcastProfile: "h_i_l_v2" };
    await seedRegistry(serverId, reg);
    resetSfuMock();
    expect((await pull(owner, serverId, screenTrack, "h")).status).toBe(200);
    const v2 = must(
      sfuMockCalls.find((call) => call.op === "newRemoteTracks"),
      "v2 pull",
    );
    expect(v2.payload).toMatchObject({
      tracks: [
        {
          simulcast: {
            preferredRid: "h",
            priorityOrdering: "none",
            ridNotAvailable: "none",
          },
        },
      ],
    });
  });

  it("mic pull needs no grant (voice auto-subscribe)", async () => {
    const owner = await register("rtc_pull_c");
    const viewerId = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-pull-c");
    const { micTrack } = await setupPull(serverId, viewerId, crypto.randomUUID());

    const res = await pull(owner, serverId, micTrack);
    expect(res.status).toBe(200);
  });
});

describe("FR-19 sdp ops (passthrough)", () => {
  it("renegotiate forwards the answer to the SFU as a PUT", async () => {
    const owner = await register("rtc_sdp_a");
    const serverId = await createServer(owner, "rtc-sdp-a");
    resetSfuMock();

    const answer = { type: "answer", sdp: "v=0\r\na=answer\r\n" };
    const res = await authed(owner, `/api/rtc/${serverId}/renegotiate?session=sess-x`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionDescription: answer }),
    });
    expect(res.status).toBe(200);
    const call = must(
      sfuMockCalls.find((c) => c.op === "renegotiate"),
      "renegotiate call",
    );
    expect(call.method).toBe("PUT");
    expect(call.sessionId).toBe("sess-x");
    expect(call.payload).toEqual({ sessionDescription: answer });
  });

  it("tracks/update forwards the layer switch to the SFU as a PUT", async () => {
    const owner = await register("rtc_sdp_b");
    const serverId = await createServer(owner, "rtc-sdp-b");
    resetSfuMock();

    const res = await authed(owner, `/api/rtc/${serverId}/tracks/update?session=sess-y`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracks: [{ mid: "2", simulcast: { preferredRid: "h" } }] }),
    });
    expect(res.status).toBe(200);
    const call = must(
      sfuMockCalls.find((c) => c.op === "updateTrack"),
      "updateTrack call",
    );
    expect(call.method).toBe("PUT");
    expect(call.sessionId).toBe("sess-y");
    // The Worker PINS the requested layer (priorityOrdering/ridNotAvailable "none") so the SFU's
    // automatic mode can never bounce a fullscreen watcher back to the 270p l layer on a BWE dip.
    expect(call.payload).toEqual({
      mid: "2",
      simulcast: { preferredRid: "h", priorityOrdering: "none", ridNotAvailable: "none" },
    });
  });

  it("tracks/update with a trackName reprices the DO watch grant (FR-33 op:'layer', G5)", async () => {
    const owner = await register("rtc_sdp_layer");
    const viewerId = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-sdp-layer");
    const publisherId = crypto.randomUUID();
    const screenTrack = `screen:${publisherId}:1`;
    // Seed a published screen + the viewer's watch grant at the high layer.
    await seedRegistry(serverId, {
      sessions: { "pub-sess": { userId: publisherId, mediaReadyVersion: 2 } },
      tracks: {
        [screenTrack]: {
          userId: publisherId,
          sessionId: "pub-sess",
          kind: "screen",
          preset: "1080p30",
        },
      },
      pending: {},
      grants: { [viewerId]: { [screenTrack]: "h" } },
      deliveries: { [viewerId]: { [screenTrack]: "video" } },
    });
    resetSfuMock();

    // Focus → grid: the client sends the trackName alongside the mid; the DO drops the grant to 'l'.
    const res = await authed(owner, `/api/rtc/${serverId}/tracks/update?session=sess-l`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tracks: [{ mid: "4", trackName: screenTrack, simulcast: { preferredRid: "l" } }],
      }),
    });
    expect(res.status).toBe(200);
    // The SFU still received the passthrough switch...
    expect(sfuMockCalls.some((c) => c.op === "updateTrack")).toBe(true);
    // ...and the DO grant was repriced h → l.
    const reg = await readRegistry(serverId);
    expect(reg.grants[viewerId]?.[screenTrack]).toBe("l");
  });

  it("watch/delivery keeps the grant while persisting audio-only saver mode", async () => {
    const owner = await register("rtc_watch_delivery");
    const viewerId = await meUserId(owner);
    const serverId = await createServer(owner, "rtc-watch-delivery");
    const publisherId = crypto.randomUUID();
    const screenTrack = `screen:${publisherId}:1`;
    await seedRegistry(serverId, {
      sessions: { "pub-sess": { userId: publisherId, mediaReadyVersion: 2 } },
      tracks: {
        [screenTrack]: {
          userId: publisherId,
          sessionId: "pub-sess",
          kind: "screen",
          preset: "1080p30",
          hasAudio: true,
        },
      },
      pending: {},
      grants: { [viewerId]: { [screenTrack]: "h" } },
      deliveries: { [viewerId]: { [screenTrack]: "video" } },
    });

    const res = await authed(owner, `/api/rtc/${serverId}/watch/delivery`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackName: screenTrack, delivery: "audio" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trackName: screenTrack, delivery: "audio" });
    const reg = await readRegistry(serverId);
    expect(reg.grants[viewerId]?.[screenTrack]).toBe("h");
    expect(reg.deliveries[viewerId]?.[screenTrack]).toBe("audio");
  });

  it("close forwards the mids + force flag to the SFU tracks/close (PUT)", async () => {
    const owner = await register("rtc_sdp_c");
    const serverId = await createServer(owner, "rtc-sdp-c");
    resetSfuMock();

    const res = await authed(owner, `/api/rtc/${serverId}/close?session=sess-z`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracks: [{ mid: "3" }], force: true }),
    });
    expect(res.status).toBe(200);
    const call = must(
      sfuMockCalls.find((c) => c.op === "closeTracks"),
      "closeTracks call",
    );
    expect(call.method).toBe("PUT");
    expect(call.sessionId).toBe("sess-z");
    expect(call.payload).toMatchObject({ mids: ["3"], force: true });
  });
});

describe("FR-19 rtc rate limit", () => {
  it("more than LIMITS.rateRtcOpsPerMin ops in a minute → rtc_rate_limited (429)", async () => {
    const token = await register("rtc_ratelimit");
    // The window counter is incremented synchronously before `await next()`, so 60 concurrent ops
    // land exactly at the cap (all 200); the 61st then exceeds it.
    const first60 = await Promise.all(
      Array.from({ length: 60 }, () => authed(token, "/api/rtc/ice")),
    );
    expect(first60.every((r) => r.status === 200)).toBe(true);

    const limited = await authed(token, "/api/rtc/ice");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rtc_rate_limited" });
  });
});

describe("GET /api/rtc/ice", () => {
  it("mock mode returns the Cloudflare STUN entry only", async () => {
    const token = await register("rtc_ice_a");
    const res = await authed(token, "/api/rtc/ice");
    expect(res.status).toBe(200);
    const body: { iceServers: Array<{ urls: string | string[] }> } = await res.json();
    expect(body.iceServers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });

  it("unauthenticated → 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/rtc/ice`);
    expect(res.status).toBe(401);
  });
});

// The real (non-mock) Realtime client + TURN fetch, exercised with a stubbed global fetch — the pinned
// §7.1 verbs (POST sessions/tracks, PUT renegotiate/update/close) + the Bearer app secret.
describe("realtime SFU client (real, fetch-stubbed)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hits the pinned URLs + verbs with the app-secret Bearer", async () => {
    const seen: Array<{
      url: string;
      method: string;
      auth: string | null;
      body: BodyInit | null | undefined;
      contentType: string | null;
    }> = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("authorization"),
        body: init?.body,
        contentType: new Headers(init?.headers).get("content-type"),
      });
      return Response.json({ sessionId: "s-1", requiresImmediateRenegotiation: false, tracks: [] });
    });

    const client = createRealtimeClient({
      REALTIME_APP_ID: "app7",
      REALTIME_APP_SECRET: "secret7",
    });
    await client.newSession();
    await client.newLocalTracks("s-1", { type: "offer", sdp: "x" }, []);
    await client.newRemoteTracks("s-1", [
      { location: "remote", sessionId: "p-1", trackName: "mic:x" },
    ]);
    await client.renegotiate("s-1", { type: "answer", sdp: "y" });
    await client.updateTrack("s-1", "0", { preferredRid: "l" });
    await client.closeTracks("s-1", ["0"], undefined, true);

    expect(seen[0]).toMatchObject({
      url: "https://rtc.live.cloudflare.com/v1/apps/app7/sessions/new",
      method: "POST",
      auth: "Bearer secret7",
    });
    // sessions/new must carry NO body — the real SFU answers 400 decoding_error to `{}`.
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[0]?.contentType).toBeNull();
    expect(seen[1]?.body).toBeDefined();
    expect(seen[1]?.url).toContain("/sessions/s-1/tracks/new");
    expect(seen[1]?.method).toBe("POST");
    expect(seen[2]).toMatchObject({ url: expect.stringContaining("/tracks/new"), method: "POST" });
    expect(seen[3]).toMatchObject({ url: expect.stringContaining("/renegotiate"), method: "PUT" });
    expect(seen[4]).toMatchObject({
      url: expect.stringContaining("/tracks/update"),
      method: "PUT",
    });
    expect(seen[5]).toMatchObject({ url: expect.stringContaining("/tracks/close"), method: "PUT" });
  });

  it("keeps mock mode credential-free and rejects an unconfigured real SFU client", async () => {
    const mockClient = createRealtimeClient({ TAVERN_SFU_MOCK: "1" });
    await expect(mockClient.newSession()).resolves.toMatchObject({ sessionId: expect.any(String) });

    expect(() => createRealtimeClient({})).toThrow(
      "Missing required environment binding: REALTIME_APP_ID",
    );
  });

  // The bounded transient retry (S12.4 soak finding — realtime.ts header). 5xx/thrown fetch =
  // transient (the SFU did not serve the request) → up to 2 replays; 4xx = semantic, never replayed.
  it("retries a transient 503 and succeeds on the replay", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) return new Response("upstream sad", { status: 503 });
      return Response.json({ sessionId: "s-1" });
    });
    const client = createRealtimeClient({ REALTIME_APP_ID: "a", REALTIME_APP_SECRET: "s" });
    await expect(client.newSession()).resolves.toEqual({ sessionId: "s-1" });
    expect(calls).toBe(2);
  });

  it("exhausts the bounded retries on persistent 5xx and throws the typed error", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("still sad", { status: 503 });
    });
    const client = createRealtimeClient({ REALTIME_APP_ID: "a", REALTIME_APP_SECRET: "s" });
    const err = await client.newSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealtimeError);
    expect((err as RealtimeError).status).toBe(503);
    expect(calls).toBe(3); // 1 attempt + 2 bounded retries
  });

  it("never retries a 4xx", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("no", { status: 400 });
    });
    const client = createRealtimeClient({ REALTIME_APP_ID: "a", REALTIME_APP_SECRET: "s" });
    const err = await client.newSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealtimeError);
    expect((err as RealtimeError).status).toBe(400);
    expect(calls).toBe(1);
  });

  it("retries a thrown fetch (network blip) and succeeds on the replay", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      return Response.json({ sessionId: "s-2" });
    });
    const client = createRealtimeClient({ REALTIME_APP_ID: "a", REALTIME_APP_SECRET: "s" });
    await expect(client.newSession()).resolves.toEqual({ sessionId: "s-2" });
    expect(calls).toBe(2);
  });

  it("fetchTurnIceServers posts ttl:3600 with the TURN Bearer and normalizes to an array", async () => {
    let body: unknown;
    let auth: string | null = null;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      expect(String(input)).toContain("/turn/keys/turnkey1/credentials/generate-ice-servers");
      auth = new Headers(init?.headers).get("authorization");
      body = JSON.parse(String(init?.body));
      return Response.json({
        iceServers: { urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" },
      });
    });

    const servers = await fetchTurnIceServers({
      TURN_KEY_ID: "turnkey1",
      TURN_KEY_API_TOKEN: "turntoken1",
    });
    expect(auth).toBe("Bearer turntoken1");
    expect(body).toEqual({ ttl: 3600 });
    expect(servers).toEqual([
      { urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" },
    ]);
  });
});
