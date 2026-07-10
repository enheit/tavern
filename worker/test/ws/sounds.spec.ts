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
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`sounds-${Date.now()}-${roomSeq}`));
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
  async waitForType<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    return await vi.waitFor(() => must(this.messages.find(isType(t)), `awaiting ${t}`), {
      timeout: 3000,
      interval: 25,
    });
  }
  async waitForCount(t: ServerMessage["t"], n: number): Promise<void> {
    await vi.waitFor(
      () => {
        if (this.count(t) < n) throw new Error(`awaiting ${n}× ${t}; have ${this.count(t)}`);
      },
      { timeout: 3000, interval: 25 },
    );
  }
}

async function connect(stub: RoomStub, userId: string): Promise<{ ws: WebSocket; col: Collector }> {
  const ws = await (async () => {
    const res = await stub.fetch(
      `https://do.internal/ws?ticket=${await mintTicket(stub, userId)}`,
      {
        headers: { Upgrade: "websocket" },
      },
    );
    expect(res.status).toBe(101);
    const socket = must(res.webSocket, "expected webSocket");
    socket.accept();
    return socket;
  })();
  const col = new Collector(ws);
  ws.send(HELLO);
  await col.waitForType("hello.ok");
  return { ws, col };
}

describe("FR-34 soundboard upload", () => {
  it("broadcasts sound.updated after /internal/sounds/create", async () => {
    const stub = freshRoom();
    const a = memberInit(true);
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });
    const { ws, col } = await connect(stub, a.userId);

    const sound = newSound(a.userId);
    const res = await internalPost(stub, "/internal/sounds/create", {
      sound,
      r2Key: `sounds/x/${sound.id}.mp3`,
    });
    expect(res.status).toBe(200);
    const body: { sound: { id: string; playCount: number } } = await res.json();
    expect(body.sound.id).toBe(sound.id);
    expect(body.sound.playCount).toBe(0);

    const frame = await col.waitForType("sound.updated");
    expect(typeof frame.at).toBe("number");
    ws.close();
  });

  it("rate-limits the 11th create within the hour with 429 rate_limited", async () => {
    const stub = freshRoom();
    const a = memberInit(true);
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });

    // The DO serializes requests, so parallel creates still process one-by-one (10 under the cap).
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const sound = newSound(a.userId);
        const ok = await internalPost(stub, "/internal/sounds/create", {
          sound,
          r2Key: `sounds/x/${sound.id}.mp3`,
        });
        expect(ok.status).toBe(200);
      }),
    );
    const eleventh = newSound(a.userId);
    const res = await internalPost(stub, "/internal/sounds/create", {
      sound: eleventh,
      r2Key: `sounds/x/${eleventh.id}.mp3`,
    });
    expect(res.status).toBe(429);
    const body: { error: string } = await res.json();
    expect(body.error).toBe("rate_limited");
  });
});

describe("FR-35 trim dialog", () => {
  it("broadcasts sound.updated after a patch, and rejects a non-uploader with forbidden", async () => {
    const stub = freshRoom();
    const owner = memberInit();
    const other = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: owner.userId };
    await seed(stub, owner, meta);
    await seed(stub, other, meta);
    const { ws, col } = await connect(stub, owner.userId);

    const sound = newSound(owner.userId);
    await internalPost(stub, "/internal/sounds/create", {
      sound,
      r2Key: `sounds/x/${sound.id}.mp3`,
    });
    await col.waitForCount("sound.updated", 1);

    // Non-uploader, non-admin → forbidden, no extra broadcast.
    const denied = await internalPost(stub, "/internal/sounds/patch", {
      soundId: sound.id,
      patch: { name: "hijack" },
      actor: { userId: other.userId, isAdmin: false },
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("forbidden");

    // Uploader trims → 200 + broadcast.
    const patched = await internalPost(stub, "/internal/sounds/patch", {
      soundId: sound.id,
      patch: { trimStartMs: 100, trimEndMs: 600 },
      actor: { userId: owner.userId, isAdmin: false },
    });
    expect(patched.status).toBe(200);
    await col.waitForCount("sound.updated", 2);
    ws.close();
  });

  it("broadcasts sound.updated after a delete and returns the r2 key", async () => {
    const stub = freshRoom();
    const owner = memberInit();
    await seed(stub, owner, { id: crypto.randomUUID(), nickname: "r", adminUserId: owner.userId });
    const { ws, col } = await connect(stub, owner.userId);

    const sound = newSound(owner.userId);
    const r2Key = `sounds/x/${sound.id}.mp3`;
    await internalPost(stub, "/internal/sounds/create", { sound, r2Key });
    await col.waitForCount("sound.updated", 1);

    const res = await internalPost(stub, "/internal/sounds/delete", {
      soundId: sound.id,
      actor: { userId: owner.userId, isAdmin: false },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { r2Key: string }).r2Key).toBe(r2Key);
    await col.waitForCount("sound.updated", 2);
    ws.close();
  });
});
