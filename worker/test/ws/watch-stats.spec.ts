import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { serverMessageSchema } from "@tavern/shared";
import type { MemberInit, ServerMessage } from "@tavern/shared";
import { PointsModule } from "../../src/do/points";
import { RoomState } from "../../src/do/roomState";

// FR-40 watch/stream stat + G1/G5 meter WIRING (WS side): the ServerRoom watch.start/stop +
// stream.start/stop handlers must open/close the grant, the cost-meter watch, and the stat intervals.
// Deterministic — we assert the OPENED/CLOSED registry+KV state, not elapsed seconds (the accrual math
// lives in the injected-clock unit tests).
const HELLO = JSON.stringify({ t: "hello", proto: 1 });
type RoomMeta = { id: string; nickname: string; adminUserId: string };
type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;
type OpenIntervals = { streams: Record<string, number>; watches: Record<string, number> };
type OpenWatches = Record<string, unknown>;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

let roomSeq = 0;
function freshRoom(): RoomStub {
  roomSeq += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`watchwire-${Date.now()}-${roomSeq}`));
}

function memberInit(): MemberInit {
  const userId = crypto.randomUUID();
  return {
    userId,
    username: `u${userId.replace(/-/g, "").slice(0, 12)}`,
    displayName: "Member",
    color: "#a1b2c3",
    isAdmin: false,
    joinedAt: Date.now(),
  };
}

function internalPost(stub: RoomStub, path: string, body: unknown): Promise<Response> {
  return stub.fetch(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
    body: JSON.stringify(body),
  });
}

async function transitionPublication(
  stub: RoomStub,
  userId: string,
  sessionId: string,
  publicationId: string,
  op: "publish.accept" | "publish.commit",
): Promise<void> {
  const response = await internalPost(stub, "/internal/rtc/authorize", {
    op,
    userId,
    sessionId,
    publicationId,
  });
  expect(await response.json()).toEqual({ ok: true });
}

async function seed(stub: RoomStub, member: MemberInit, meta: RoomMeta): Promise<void> {
  const res = await internalPost(stub, "/internal/member-join", { member, serverMeta: meta });
  expect(res.status).toBe(204);
}

async function openSocket(stub: RoomStub, userId: string): Promise<WebSocket> {
  const ticketRes = await internalPost(stub, "/internal/ticket", { userId });
  const { ticket }: { ticket: string } = await ticketRes.json();
  const res = await stub.fetch(`https://do.internal/ws?ticket=${ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = must(res.webSocket, "expected webSocket");
  ws.accept();
  return ws;
}

function isType<T extends ServerMessage["t"]>(t: T) {
  return (m: ServerMessage): m is Extract<ServerMessage, { t: T }> => m.t === t;
}

async function connect(stub: RoomStub, userId: string): Promise<WebSocket> {
  const ws = await openSocket(stub, userId);
  const received: ServerMessage[] = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string")
      received.push(serverMessageSchema.parse(JSON.parse(event.data)));
  });
  ws.send(HELLO);
  await vi.waitFor(() => {
    if (!received.some(isType("hello.ok"))) throw new Error("no hello.ok yet");
  });
  return ws;
}

function metaFor(admin: string): RoomMeta {
  return { id: crypto.randomUUID(), nickname: "wireroom", adminUserId: admin };
}

async function seedScreen(stub: RoomStub, publisher: MemberInit): Promise<string> {
  const track = `screen:${publisher.userId}:1`;
  const sessionId = `sess-${publisher.userId}`;
  const session = await internalPost(stub, "/internal/rtc/authorize", {
    op: "session.new",
    userId: publisher.userId,
    sessionId,
    mediaReadyVersion: 2,
  });
  expect(await session.json()).toEqual({ ok: true });

  const reserved = await internalPost(stub, "/internal/rtc/authorize", {
    op: "publish.reserve",
    userId: publisher.userId,
    sessionId,
    tracks: [{ trackName: track, kind: "screen", preset: "720p30" }],
  });
  const reservation = (await reserved.json()) as { ok: boolean; publicationId?: string };
  expect(reservation.ok).toBe(true);
  const publicationId = must(reservation.publicationId, "expected publication id");

  await transitionPublication(stub, publisher.userId, sessionId, publicationId, "publish.accept");
  await transitionPublication(stub, publisher.userId, sessionId, publicationId, "publish.commit");
  return track;
}

async function readState(
  stub: RoomStub,
  viewerId: string,
  track: string,
): Promise<{ grant: string | undefined; openWatch: boolean; openMeter: boolean }> {
  return runInDurableObject(stub, async (_i, state) => {
    const reg = await new RoomState(state, env).rtcSnapshot();
    const open = (await state.storage.get<OpenIntervals>("stats:open")) ?? {
      streams: {},
      watches: {},
    };
    const meter = (await state.storage.get<OpenWatches>("cost:open")) ?? {};
    const streamerId = track.split(":")[1] ?? "";
    return {
      grant: reg.grants[viewerId]?.[track],
      openWatch: `${viewerId}:${streamerId}` in open.watches,
      openMeter: `${viewerId}|${track}` in meter,
    };
  });
}

async function streamOpen(stub: RoomStub, userId: string): Promise<boolean> {
  return runInDurableObject(stub, async (_i, state) => {
    const open = (await state.storage.get<OpenIntervals>("stats:open")) ?? {
      streams: {},
      watches: {},
    };
    return userId in open.streams;
  });
}

async function pointRate(stub: RoomStub, userId: string): Promise<number> {
  return runInDurableObject(
    stub,
    (_instance, state) =>
      new PointsModule(state.storage.sql).snapshot(userId, Date.now()).currentRatePerMinute,
  );
}

describe("FR-40 watch wiring", () => {
  it("watch.start seeds the grant + meter watch + stat interval; watch.stop clears all three", async () => {
    const stub = freshRoom();
    const a = memberInit(); // streamer
    const b = memberInit(); // viewer
    const meta = metaFor(a.userId);
    await seed(stub, a, meta);
    await seed(stub, b, meta);
    const wsA = await connect(stub, a.userId);
    const wsB = await connect(stub, b.userId);
    wsA.send(JSON.stringify({ t: "voice.join", mediaReadyVersion: 2 }));
    wsB.send(JSON.stringify({ t: "voice.join", mediaReadyVersion: 2 }));
    const track = await seedScreen(stub, a);

    wsB.send(JSON.stringify({ t: "watch.start", trackName: track }));
    await vi.waitFor(async () => {
      const s = await readState(stub, b.userId, track);
      expect(s).toEqual({ grant: "h", openWatch: true, openMeter: true });
      expect(await pointRate(stub, a.userId)).toBe(10);
      expect(await pointRate(stub, b.userId)).toBe(10);
    });

    wsB.send(JSON.stringify({ t: "watch.stop", trackName: track }));
    await vi.waitFor(async () => {
      const s = await readState(stub, b.userId, track);
      expect(s).toEqual({ grant: undefined, openWatch: false, openMeter: false });
      expect(await pointRate(stub, a.userId)).toBe(5);
      expect(await pointRate(stub, b.userId)).toBe(5);
    });

    wsA.close();
    wsB.close();
  });

  it("watch.start on an unknown track → bad_message, no grant seeded", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const meta = metaFor(a.userId);
    await seed(stub, a, meta);
    const wsA = await connect(stub, a.userId);
    const received: ServerMessage[] = [];
    wsA.addEventListener("message", (event) => {
      if (typeof event.data === "string")
        received.push(serverMessageSchema.parse(JSON.parse(event.data)));
    });
    wsA.send(JSON.stringify({ t: "voice.join", mediaReadyVersion: 2 }));

    wsA.send(JSON.stringify({ t: "watch.start", trackName: `screen:${crypto.randomUUID()}:1` }));
    await vi.waitFor(() => {
      const err = received.find(isType("error"));
      expect(err?.code).toBe("bad_message");
    });

    wsA.close();
  });

  it("rejects self-watching so one person cannot earn both stream bonuses alone", async () => {
    const stub = freshRoom();
    const member = memberInit();
    const meta = metaFor(member.userId);
    await seed(stub, member, meta);
    const ws = await connect(stub, member.userId);
    const received: ServerMessage[] = [];
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string")
        received.push(serverMessageSchema.parse(JSON.parse(event.data)));
    });
    ws.send(JSON.stringify({ t: "voice.join", mediaReadyVersion: 2 }));
    const track = await seedScreen(stub, member);

    ws.send(JSON.stringify({ t: "watch.start", trackName: track }));

    await vi.waitFor(() => {
      const error = received.find(isType("error"));
      expect(error?.code).toBe("bad_message");
    });
    expect(await readState(stub, member.userId, track)).toEqual({
      grant: undefined,
      openWatch: false,
      openMeter: false,
    });
    ws.close();
  });

  it("stream.start opens the streamer clock; stream.stop closes it", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const meta = metaFor(a.userId);
    await seed(stub, a, meta);
    const wsA = await connect(stub, a.userId);
    wsA.send(JSON.stringify({ t: "voice.join", mediaReadyVersion: 2 }));
    const track = await seedScreen(stub, a);

    wsA.send(
      JSON.stringify({ t: "stream.start", kind: "screen", trackName: track, preset: "720p30" }),
    );
    await vi.waitFor(async () => {
      expect(await streamOpen(stub, a.userId)).toBe(true);
    });

    wsA.send(JSON.stringify({ t: "stream.stop", trackName: track }));
    await vi.waitFor(async () => {
      expect(await streamOpen(stub, a.userId)).toBe(false);
    });

    wsA.close();
  });
});
