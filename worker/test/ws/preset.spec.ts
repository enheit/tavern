import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { serverMessageSchema } from "@tavern/shared";
import type { MemberInit, ServerMessage } from "@tavern/shared";
import { RoomState } from "../../src/do/roomState";

// FR-27 on-the-fly preset switch — DO side. The publisher's `stream.preset` updates the registry (so a
// NEW watcher meters at the new rate) + broadcasts `stream.updated`; a non-owner is rejected with
// `bad_message` and changes NOTHING (registry preset, no broadcast).
const HELLO = JSON.stringify({ t: "hello", proto: 1 });
type RoomMeta = { id: string; nickname: string; adminUserId: string };
type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function isType<T extends ServerMessage["t"]>(t: T) {
  return (m: ServerMessage): m is Extract<ServerMessage, { t: T }> => m.t === t;
}

let roomSeq = 0;
function freshRoom(): RoomStub {
  roomSeq += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`preset-${Date.now()}-${roomSeq}`));
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

class Collector {
  readonly messages: ServerMessage[] = [];
  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string")
        this.messages.push(serverMessageSchema.parse(JSON.parse(event.data)));
    });
  }
  count<T extends ServerMessage["t"]>(t: T): number {
    return this.messages.filter(isType(t)).length;
  }
  async waitForType<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    return vi.waitFor(
      () => {
        const found = this.messages.find(isType(t));
        if (found === undefined)
          throw new Error(`awaiting ${t}; have [${this.messages.map((m) => m.t).join(", ")}]`);
        return found;
      },
      { timeout: 3000, interval: 25 },
    );
  }
}

async function connect(stub: RoomStub, userId: string): Promise<{ ws: WebSocket; col: Collector }> {
  const ws = await openSocket(stub, userId);
  const col = new Collector(ws);
  ws.send(HELLO);
  await col.waitForType("hello.ok");
  return { ws, col };
}

function metaFor(admin: string): RoomMeta {
  return { id: crypto.randomUUID(), nickname: "presetroom", adminUserId: admin };
}

async function registryPreset(stub: RoomStub, trackName: string): Promise<string | undefined> {
  return runInDurableObject(stub, async (_i, state) => {
    const reg = await new RoomState(state, env).rtcSnapshot();
    return reg.tracks[trackName]?.preset;
  });
}

// A registers a screen publish (in voice) so the DO registry has an owned screen track at 720p30.
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
  const reservation: { ok: boolean; publicationId?: string } = await reserved.json();
  expect(reservation.ok).toBe(true);
  const publicationId = must(reservation.publicationId, "expected publication id");

  const accepted = await internalPost(stub, "/internal/rtc/authorize", {
    op: "publish.accept",
    userId: publisher.userId,
    sessionId,
    publicationId,
  });
  expect(await accepted.json()).toEqual({ ok: true });
  const committed = await internalPost(stub, "/internal/rtc/authorize", {
    op: "publish.commit",
    userId: publisher.userId,
    sessionId,
    publicationId,
  });
  expect(await committed.json()).toEqual({ ok: true });
  return track;
}

describe("FR-27 preset guard", () => {
  it("owner stream.preset updates the registry + broadcasts stream.updated to peers", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta = metaFor(a.userId);
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const { ws: wsA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);
    wsA.send(JSON.stringify({ t: "voice.join", mediaReadyVersion: 2 }));
    await colB.waitForType("voice.state");
    const track = await seedScreen(stub, a);

    wsA.send(JSON.stringify({ t: "stream.preset", trackName: track, preset: "1080p30" }));

    const updated = await colB.waitForType("stream.updated");
    expect(updated).toMatchObject({ trackName: track, preset: "1080p30" });
    expect(typeof updated.at).toBe("number");
    expect(await registryPreset(stub, track)).toBe("1080p30");

    wsA.close();
    wsB.close();
  });

  it("stream.preset from a non-owner → error{bad_message} and NO reprice/broadcast", async () => {
    const stub = freshRoom();
    const a = memberInit(); // publisher/owner
    const b = memberInit(); // attacker
    const meta = metaFor(a.userId);
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const { ws: wsA, col: colA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);
    wsA.send(JSON.stringify({ t: "voice.join", mediaReadyVersion: 2 }));
    await colB.waitForType("voice.state");
    const track = await seedScreen(stub, a);

    // B does not own A's screen → the DO must reject and leave the registry preset unchanged.
    wsB.send(JSON.stringify({ t: "stream.preset", trackName: track, preset: "480p15" }));

    const err = await colB.waitForType("error");
    expect(err.code).toBe("bad_message");
    // No stream.updated was broadcast (neither peer saw one) and the preset stayed 720p30.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(colA.count("stream.updated")).toBe(0);
    expect(colB.count("stream.updated")).toBe(0);
    expect(await registryPreset(stub, track)).toBe("720p30");

    wsA.close();
    wsB.close();
  });
});
