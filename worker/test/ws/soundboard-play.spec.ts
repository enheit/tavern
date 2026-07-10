import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { serverMessageSchema } from "@tavern/shared";
import type { MemberInit, ServerMessage } from "@tavern/shared";

const HELLO = JSON.stringify({ t: "hello", proto: 1 });

type RoomMeta = { id: string; nickname: string; adminUserId: string };
type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;

// A not-yet-persisted sound (playCount is derived, so omitted) as the /internal/sounds/create body.
type NewSound = {
  id: string;
  name: string;
  uploaderId: string;
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number;
  createdAt: number;
};

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
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`sbplay-${Date.now()}-${roomSeq}`));
}

function uname(): string {
  return `u${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function memberInit(isAdmin = false): MemberInit {
  return {
    userId: crypto.randomUUID(),
    username: uname(),
    displayName: "Member",
    color: "#a1b2c3",
    isAdmin,
    joinedAt: Date.now(),
  };
}

function newSound(uploaderId: string): NewSound {
  return {
    id: crypto.randomUUID(),
    name: "clip",
    uploaderId,
    durationMs: 1000,
    trimStartMs: 0,
    trimEndMs: 1000,
    createdAt: Date.now(),
  };
}

function internalPost(stub: RoomStub, path: string, body: unknown): Promise<Response> {
  return stub.fetch(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
    body: JSON.stringify(body),
  });
}

function internalGet(stub: RoomStub, path: string): Promise<Response> {
  return stub.fetch(`https://do.internal${path}`, {
    method: "GET",
    headers: { "X-Tavern-Internal": "1" },
  });
}

async function seed(stub: RoomStub, member: MemberInit, meta: RoomMeta): Promise<void> {
  const res = await internalPost(stub, "/internal/member-join", { member, serverMeta: meta });
  expect(res.status).toBe(204);
}

async function mintTicket(stub: RoomStub, userId: string): Promise<string> {
  const res = await internalPost(stub, "/internal/ticket", { userId });
  expect(res.status).toBe(200);
  const body: { ticket: string } = await res.json();
  return body.ticket;
}

async function createSound(stub: RoomStub, sound: NewSound): Promise<void> {
  const res = await internalPost(stub, "/internal/sounds/create", {
    sound,
    r2Key: `sounds/x/${sound.id}.mp3`,
  });
  expect(res.status).toBe(200);
}

async function playCountOf(stub: RoomStub, soundId: string): Promise<number> {
  const res = await internalGet(stub, "/internal/sounds");
  expect(res.status).toBe(200);
  const body: { sounds: Array<{ id: string; playCount: number }> } = await res.json();
  return must(
    body.sounds.find((s) => s.id === soundId),
    `sound ${soundId} not listed`,
  ).playCount;
}

class Collector {
  readonly messages: ServerMessage[] = [];
  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const raw = event.data;
      if (typeof raw !== "string") return;
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw)));
    });
  }
  count(t: ServerMessage["t"]): number {
    return this.messages.filter((m) => m.t === t).length;
  }
  find<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.messages.find(isType(t));
  }
  async waitForType<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    return await vi.waitFor(() => must(this.messages.find(isType(t)), `awaiting ${t}`), {
      timeout: 3000,
      interval: 25,
    });
  }
}

async function connect(stub: RoomStub, userId: string): Promise<{ ws: WebSocket; col: Collector }> {
  const res = await stub.fetch(`https://do.internal/ws?ticket=${await mintTicket(stub, userId)}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const socket = must(res.webSocket, "expected webSocket");
  socket.accept();
  const col = new Collector(socket);
  socket.send(HELLO);
  await col.waitForType("hello.ok");
  return { ws: socket, col };
}

describe("FR-36 sound.play", () => {
  it("play inserts sound_plays row and broadcasts sound.played to all sockets", async () => {
    const stub = freshRoom();
    const a = memberInit(true);
    const b = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, b, meta);
    const sound = newSound(a.userId);
    await createSound(stub, sound);

    const ca = await connect(stub, a.userId);
    const cb = await connect(stub, b.userId);

    ca.ws.send(JSON.stringify({ t: "sound.play", soundId: sound.id }));

    // Broadcast reaches BOTH the sender (A) and the peer (B) — the sender plays on its own receipt.
    const onA = await ca.col.waitForType("sound.played");
    const onB = await cb.col.waitForType("sound.played");
    expect(onA).toMatchObject({ soundId: sound.id, byUserId: a.userId });
    expect(onB).toMatchObject({ soundId: sound.id, byUserId: a.userId });
    expect(typeof onA.at).toBe("number");
    // A row was inserted (playCount reflects it).
    expect(await playCountOf(stub, sound.id)).toBe(1);

    ca.ws.close();
    cb.ws.close();
  });

  it("second play within 1s from same user → rate_limited error, no row", async () => {
    const stub = freshRoom();
    const a = memberInit(true);
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });
    const sound = newSound(a.userId);
    await createSound(stub, sound);
    const ca = await connect(stub, a.userId);

    ca.ws.send(JSON.stringify({ t: "sound.play", soundId: sound.id }));
    await ca.col.waitForType("sound.played");
    ca.ws.send(JSON.stringify({ t: "sound.play", soundId: sound.id }));
    const err = await ca.col.waitForType("error");
    expect(err.code).toBe("rate_limited");

    // The rejected play produced NO additional broadcast and NO extra row.
    expect(ca.col.count("sound.played")).toBe(1);
    expect(await playCountOf(stub, sound.id)).toBe(1);

    ca.ws.close();
  });

  it("unknown soundId → not_found", async () => {
    const stub = freshRoom();
    const a = memberInit(true);
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });
    const ca = await connect(stub, a.userId);

    ca.ws.send(JSON.stringify({ t: "sound.play", soundId: crypto.randomUUID() }));
    const err = await ca.col.waitForType("error");
    expect(err.code).toBe("not_found");
    expect(ca.col.count("sound.played")).toBe(0);

    ca.ws.close();
  });

  describe("FR-37 stats", () => {
    it("playCount in GET sounds reflects sound_plays rows", async () => {
      const stub = freshRoom();
      const a = memberInit(true);
      const b = memberInit();
      const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
      await seed(stub, a, meta);
      await seed(stub, b, meta);
      const sound = newSound(a.userId);
      await createSound(stub, sound);
      expect(await playCountOf(stub, sound.id)).toBe(0);

      const ca = await connect(stub, a.userId);
      const cb = await connect(stub, b.userId);
      // Two DIFFERENT users each play once (per-user rate limit → both accepted).
      ca.ws.send(JSON.stringify({ t: "sound.play", soundId: sound.id }));
      await ca.col.waitForType("sound.played");
      cb.ws.send(JSON.stringify({ t: "sound.play", soundId: sound.id }));
      await cb.col.waitForType("sound.played");

      expect(await playCountOf(stub, sound.id)).toBe(2);

      ca.ws.close();
      cb.ws.close();
    });
  });
});
