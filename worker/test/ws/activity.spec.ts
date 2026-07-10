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
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`activity-${Date.now()}-${roomSeq}`));
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

// Seeds a member into the DO cache + (re)writes serverMeta — the same warm-up create/join perform.
// (This call also appends the member's own `member.join` activity, broadcast to any live sockets.)
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

async function openSocket(stub: RoomStub, ticket: string): Promise<WebSocket> {
  const res = await stub.fetch(`https://do.internal/ws?ticket=${ticket}`, {
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

  count(t: ServerMessage["t"]): number {
    return this.messages.filter((m) => m.t === t).length;
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

  async waitForClose(): Promise<{ code: number; reason: string }> {
    return await vi.waitFor(() => must(this.closeInfo, "socket not closed yet"), {
      timeout: 3000,
      interval: 25,
    });
  }
}

// Opens a socket, completes the hello handshake, returns the socket + its collector.
async function connect(stub: RoomStub, userId: string): Promise<{ ws: WebSocket; col: Collector }> {
  const ws = await openSocket(stub, await mintTicket(stub, userId));
  const col = new Collector(ws);
  ws.send(HELLO);
  await col.waitForType("hello.ok");
  return { ws, col };
}

describe("FR-39 activity broadcast", () => {
  it("a new member join broadcasts activity.new{member.join} to a connected member", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);

    // A is connected BEFORE B joins → A observes B's join in real time.
    const { ws: wsA, col: colA } = await connect(stub, a.userId);
    await seed(stub, b, meta);

    const frame = await colA.waitForType("activity.new");
    expect(frame.entry.type).toBe("member.join");
    expect(frame.entry.userId).toBe(b.userId);
    expect(frame.entry.meta).toEqual({});
    expect(typeof frame.entry.id).toBe("number");
    expect(typeof frame.entry.at).toBe("number");
    // Exactly one activity.new reaches A (B's join). A's own join fired to zero sockets.
    expect(colA.count("activity.new")).toBe(1);
    wsA.close();
  });

  it("kick broadcasts activity.new{member.kick} to survivors; the kicked socket closes 4001", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const { col: colA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);

    await internalPost(stub, "/internal/kick", { userId: a.userId });

    // B (the survivor) receives the member.kick activity entry naming the kicked user.
    const frame = await colB.waitForType("activity.new");
    expect(frame.entry.type).toBe("member.kick");
    expect(frame.entry.userId).toBe(a.userId);
    expect(frame.entry.meta).toEqual({});

    // A's socket is evicted with the kicked close code, and A never receives the survivor broadcast.
    expect((await colA.waitForClose()).code).toBe(CLOSE_KICKED);
    expect(colA.count("activity.new")).toBe(0);
    wsB.close();
  });
});
