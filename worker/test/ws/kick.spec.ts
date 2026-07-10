import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { CLOSE_KICKED, serverMessageSchema } from "@tavern/shared";
import type { MemberInit, ServerMessage } from "@tavern/shared";

const HELLO = JSON.stringify({ t: "hello", proto: 1 });

type RoomMeta = { id: string; nickname: string; adminUserId: string };
// Typed stub so runInDurableObject infers the ServerRoom instance (its O must extend DurableObject).
type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;

// Non-null narrow without `!` (§9.1).
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// Type-narrowing predicate so a found frame keeps its precise discriminated-union member (no `as`).
function isType<T extends ServerMessage["t"]>(t: T) {
  return (m: ServerMessage): m is Extract<ServerMessage, { t: T }> => m.t === t;
}

// A fresh, isolated DO (unique idFromName) per test — the WS project runs `--no-isolate` (shared
// storage), so per-room isolation is achieved by never reusing a room name.
let roomSeq = 0;
function freshRoom(): RoomStub {
  roomSeq += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`kick-${Date.now()}-${roomSeq}`));
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

// Seeds a member into the DO cache and (re)writes serverMeta — the same warm-up create/join perform.
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

// Opens (and client-accepts) a hibernatable socket via the DO stub upgrade path, then hellos it.
async function openHelloedSocket(stub: RoomStub, userId: string): Promise<WebSocket> {
  const res = await stub.fetch(`https://do.internal/ws?ticket=${await mintTicket(stub, userId)}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = must(res.webSocket, "expected webSocket in upgrade response");
  ws.accept();
  return ws;
}

// Buffers every inbound (validated) frame + the close, with retry-based waiters.
class Collector {
  readonly messages: ServerMessage[] = [];
  private closeInfo: { code: number; reason: string } | null = null;

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const raw = event.data;
      if (typeof raw !== "string") return;
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw)));
    });
    ws.addEventListener("close", (event) => {
      this.closeInfo = { code: event.code, reason: event.reason };
    });
  }

  async waitForType<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    return await vi.waitFor(
      () => {
        const found = this.messages.find(isType(t));
        if (found === undefined) {
          throw new Error(`awaiting ${t}; have [${this.messages.map((m) => m.t).join(", ")}]`);
        }
        return found;
      },
      { timeout: 3000, interval: 25 },
    );
  }

  // Waits for a presence.update matching a specific user + presence (the buffer also holds each
  // socket's own `online` frames, so a bare waitForType("presence.update") would race those).
  async waitForPresence(
    userId: string,
    presence: "offline" | "online",
  ): Promise<Extract<ServerMessage, { t: "presence.update" }>> {
    return await vi.waitFor(
      () => {
        const found = this.messages
          .filter(isType("presence.update"))
          .find((m) => m.userId === userId && m.presence === presence);
        return must(found, `awaiting presence.update ${userId}=${presence}`);
      },
      { timeout: 3000, interval: 25 },
    );
  }

  async waitForClose(): Promise<{ code: number; reason: string }> {
    return await vi.waitFor(() => must(this.closeInfo, "socket not closed yet"), {
      timeout: 3000,
      interval: 25,
    });
  }
}

describe("FR-11 kick — live eviction", () => {
  it("connected member receives kicked frame then close code 4001", async () => {
    const stub = freshRoom();
    const target = memberInit();
    const admin = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: admin.userId };
    await seed(stub, admin, meta);
    await seed(stub, target, meta);

    const ws = await openHelloedSocket(stub, target.userId);
    const col = new Collector(ws);
    ws.send(HELLO);
    await col.waitForType("hello.ok");

    const res = await internalPost(stub, "/internal/kick", {
      userId: target.userId,
      by: admin.userId,
    });
    expect(res.status).toBe(200);

    // The evicted socket receives a `kicked` frame, THEN the connection closes with code 4001.
    await col.waitForType("kicked");
    expect((await col.waitForClose()).code).toBe(CLOSE_KICKED);
  });

  it("remaining member receives activity.new (member.kick) and presence.update", async () => {
    const stub = freshRoom();
    const target = memberInit();
    const admin = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: admin.userId };
    await seed(stub, admin, meta);
    await seed(stub, target, meta);

    // The admin is the surviving observer; the target holds a live socket that will be evicted.
    const wsAdmin = await openHelloedSocket(stub, admin.userId);
    const colAdmin = new Collector(wsAdmin);
    wsAdmin.send(HELLO);
    await colAdmin.waitForType("hello.ok");

    const wsTarget = await openHelloedSocket(stub, target.userId);
    const colTarget = new Collector(wsTarget);
    wsTarget.send(HELLO);
    await colTarget.waitForType("hello.ok");

    const res = await internalPost(stub, "/internal/kick", {
      userId: target.userId,
      by: admin.userId,
    });
    expect(res.status).toBe(200);

    const activity = await colAdmin.waitForType("activity.new");
    expect(activity.entry.type).toBe("member.kick");
    expect(activity.entry.userId).toBe(target.userId);
    expect(activity.entry.meta["by"]).toBe(admin.userId);

    const presence = await colAdmin.waitForPresence(target.userId, "offline");
    expect(presence.userId).toBe(target.userId);
    expect(presence.presence).toBe("offline");

    wsAdmin.close();
  });

  it("DO responds { closed: 2 } when the user had two sockets", async () => {
    const stub = freshRoom();
    const target = memberInit();
    const admin = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: admin.userId };
    await seed(stub, target, meta);

    const ws1 = await openHelloedSocket(stub, target.userId);
    const col1 = new Collector(ws1);
    ws1.send(HELLO);
    await col1.waitForType("hello.ok");

    const ws2 = await openHelloedSocket(stub, target.userId);
    const col2 = new Collector(ws2);
    ws2.send(HELLO);
    await col2.waitForType("hello.ok");

    const res = await internalPost(stub, "/internal/kick", {
      userId: target.userId,
      by: admin.userId,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: 2 });

    // Both sockets are evicted with the kick close code.
    expect((await col1.waitForClose()).code).toBe(CLOSE_KICKED);
    expect((await col2.waitForClose()).code).toBe(CLOSE_KICKED);
  });
});
