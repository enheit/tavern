import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { CLOSE_PROTOCOL_VIOLATION, serverMessageSchema } from "@tavern/shared";
import type { Member, MemberInit, ServerMessage } from "@tavern/shared";
import { ChatModule } from "../../src/do/chat";

const HELLO = JSON.stringify({ t: "hello", proto: 1 });

type RoomMeta = { id: string; nickname: string; adminUserId: string };
// Typed stub so runInDurableObject infers the ServerRoom instance (its O must extend DurableObject).
type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;
type ChatPage = Extract<ServerMessage, { t: "chat.page" }>;

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
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`chat-${Date.now()}-${roomSeq}`));
}

function uname(): string {
  return `u${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function memberInit(username: string = uname()): MemberInit {
  return {
    userId: crypto.randomUUID(),
    username,
    displayName: "Member",
    color: "#a1b2c3",
    isAdmin: false,
    joinedAt: Date.now(),
  };
}

// A full Member (presence included) for direct ChatModule.send calls (the module reads only username).
function fullMember(username: string): Member {
  return { ...memberInit(username), presence: "online" };
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

  pages(): ChatPage[] {
    return this.messages.filter(isType("chat.page"));
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

  async waitForCount(t: ServerMessage["t"], n: number): Promise<void> {
    await vi.waitFor(
      () => {
        if (this.count(t) < n) throw new Error(`awaiting ${n}× ${t}; have ${this.count(t)}`);
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

function sendChat(ws: WebSocket, body: string): string {
  const nonce = crypto.randomUUID();
  ws.send(JSON.stringify({ t: "chat.send", body, nonce }));
  return nonce;
}

// Directly seeds `count` message rows (bypassing the send rate limit, which is not under test here).
// AUTOINCREMENT assigns ids 1..count in a fresh room; created_at is strictly increasing.
async function seedMessages(stub: RoomStub, userId: string, count: number): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const base = Date.now();
    for (let i = 0; i < count; i += 1) {
      state.storage.sql.exec(
        `INSERT INTO messages (channel_id, user_id, body, mentions, created_at)
         VALUES ('main', ?, ?, '[]', ?)`,
        userId,
        `seed ${i}`,
        base + i,
      );
    }
  });
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

describe("FR-14 chat send/receive", () => {
  it("A sends → B receives chat.new without nonce; A receives with nonce", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const { ws: wsA, col: colA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);

    const nonce = sendChat(wsA, "hello world");
    const aCopy = await colA.waitForType("chat.new");
    const bCopy = await colB.waitForType("chat.new");

    expect(aCopy.nonce).toBe(nonce);
    expect(aCopy.message.body).toBe("hello world");
    expect(aCopy.message.userId).toBe(a.userId);
    expect(aCopy.message.mentions).toEqual([]);

    expect(bCopy.nonce).toBeUndefined();
    expect(bCopy.message.id).toBe(aCopy.message.id);
    expect(bCopy.message.body).toBe("hello world");

    // Exactly one copy each: the sender is excluded from the no-nonce broadcast; others from the echo.
    expect(colA.count("chat.new")).toBe(1);
    expect(colB.count("chat.new")).toBe(1);
    wsA.close();
    wsB.close();
  });

  it("2001-char body → error bad_message; nothing broadcast; nothing persisted", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const { ws: wsA, col: colA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);

    // clientMessageSchema caps the body at 2000 → the router rejects before ChatModule (task 2 is the
    // trust-boundary re-check, covered directly below).
    wsA.send(
      JSON.stringify({ t: "chat.send", body: "x".repeat(2001), nonce: crypto.randomUUID() }),
    );
    const err = await colA.waitForType("error");
    expect(err.code).toBe("bad_message");
    expect((await colA.waitForClose()).code).toBe(CLOSE_PROTOCOL_VIOLATION);

    expect(colB.count("chat.new")).toBe(0);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(`SELECT COUNT(*) AS c FROM messages`)
        .one();
      expect(Number(row["c"])).toBe(0);
    });
    wsB.close();
  });

  it("ChatModule re-checks length as a trust boundary (2001 chars → bad_message)", async () => {
    const stub = freshRoom();
    await runInDurableObject(stub, (_instance, state) => {
      const chat = new ChatModule(state.storage.sql);
      const result = chat.send({
        userId: crypto.randomUUID(),
        body: "x".repeat(2001),
        nonce: crypto.randomUUID(),
        members: [],
        now: Date.now(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected bad_message");
      expect(result.code).toBe("bad_message");
      // Rejected before persistence.
      const row = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(`SELECT COUNT(*) AS c FROM messages`)
        .one();
      expect(Number(row["c"])).toBe(0);
    });
  });

  it("11 sends in one tick → the 11th is rate_limited; the socket stays usable", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });

    const { ws, col } = await connect(stub, a.userId);
    // Burst of 11 within one tick: capacity is 10 (refill 5/s can add <1 token over the few ms this
    // takes), so exactly 10 persist + echo and the 11th is rejected on this socket.
    for (let i = 0; i < 11; i += 1) sendChat(ws, `burst ${i}`);

    await col.waitForCount("chat.new", 10);
    const err = await col.waitForType("error");
    expect(err.code).toBe("rate_limited");
    expect(col.count("chat.new")).toBe(10);

    // Socket stays open: a follow-up request is still served.
    ws.send(JSON.stringify({ t: "chat.history", limit: 20 }));
    const page = await col.waitForType("chat.page");
    expect(page.messages).toHaveLength(10);
    ws.close();
  });
});

describe("FR-15 mentions", () => {
  it("resolves @Handle case-insensitively, ignores non-members, dedupes in order", async () => {
    const stub = freshRoom();
    await runInDurableObject(stub, (_instance, state) => {
      const chat = new ChatModule(state.storage.sql);
      const bob = fullMember("bob");
      const ann = fullMember("ann");
      const members: Member[] = [bob, ann];
      const now = Date.now();

      const one = chat.send({
        userId: bob.userId,
        body: "hey @Bob",
        nonce: crypto.randomUUID(),
        members,
        now,
      });
      if (!one.ok) throw new Error("send one failed");
      expect(one.message.mentions).toEqual([bob.userId]);

      const two = chat.send({
        userId: bob.userId,
        body: "@ghost are you there",
        nonce: crypto.randomUUID(),
        members,
        now,
      });
      if (!two.ok) throw new Error("send two failed");
      expect(two.message.mentions).toEqual([]);

      const three = chat.send({
        userId: bob.userId,
        body: "@bob hi @bob @ann",
        nonce: crypto.randomUUID(),
        members,
        now,
      });
      if (!three.ok) throw new Error("send three failed");
      expect(three.message.mentions).toEqual([bob.userId, ann.userId]);
    });
  });

  it("mentioned ids arrive in the recipient's chat.new", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const bob = memberInit("bob");
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, bob, meta);

    const { ws: wsA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, bob.userId);

    sendChat(wsA, "ping @BOB now");
    const received = await colB.waitForType("chat.new");
    expect(received.message.mentions).toEqual([bob.userId]);
    wsA.close();
    wsB.close();
  });
});

describe("FR-17 history", () => {
  it("history{} returns the newest page oldest→newest with hasMore; beforeId pages the rest", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });
    await seedMessages(stub, a.userId, 55);

    const { ws, col } = await connect(stub, a.userId);
    ws.send(JSON.stringify({ t: "chat.history", limit: 50 }));
    const page1 = await col.waitForType("chat.page");
    expect(page1.messages).toHaveLength(50);
    expect(page1.hasMore).toBe(true);
    // Newest 50 (ids 6..55) returned oldest→newest.
    expect(page1.messages.map((m) => m.id)).toEqual(range(6, 55));

    const beforeId = must(page1.messages[0], "first message").id;
    ws.send(JSON.stringify({ t: "chat.history", beforeId, limit: 50 }));
    await col.waitForCount("chat.page", 2);
    const page2 = must(col.pages()[1], "second page");
    expect(page2.messages.map((m) => m.id)).toEqual(range(1, 5));
    expect(page2.hasMore).toBe(false);
    ws.close();
  });

  it("limit over the schema max is rejected at the router (bad_message + close 1008)", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });

    const { ws, col } = await connect(stub, a.userId);
    ws.send(JSON.stringify({ t: "chat.history", limit: 51 }));
    const err = await col.waitForType("error");
    expect(err.code).toBe("bad_message");
    expect((await col.waitForClose()).code).toBe(CLOSE_PROTOCOL_VIOLATION);
  });

  it("messages persist in DO SQLite across a re-read", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });

    const { ws, col } = await connect(stub, a.userId);
    sendChat(ws, "durable message");
    await col.waitForType("chat.new");
    ws.close();

    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(`SELECT body FROM messages ORDER BY id`)
        .toArray();
      expect(rows.map((r) => String(r["body"]))).toEqual(["durable message"]);
    });
  });

  it("hello.ok.lastMessageId equals the max persisted id on a fresh connection", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });
    await seedMessages(stub, a.userId, 55);

    const ws = await openSocket(stub, await mintTicket(stub, a.userId));
    const col = new Collector(ws);
    ws.send(HELLO);
    const hello = await col.waitForType("hello.ok");
    expect(hello.lastMessageId).toBe(55);
    ws.close();
  });
});
