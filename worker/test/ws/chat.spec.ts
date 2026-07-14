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

function setReaction(ws: WebSocket, messageId: number, emoji: string, reacted: boolean): string {
  const requestId = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      t: "chat.reaction.set",
      requestId,
      messageId,
      emoji,
      reacted,
    }),
  );
  return requestId;
}

function requestHistory(
  ws: WebSocket,
  mode: "initial" | "latest" | "older" | "newer" | "around",
  cursorId?: number,
): string {
  const requestId = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      t: "chat.history",
      requestId,
      mode,
      ...(cursorId === undefined ? {} : { cursorId }),
      limit: 30,
    }),
  );
  return requestId;
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

  it("ChatModule rate-limits the 11th send at a fixed timestamp", async () => {
    const stub = freshRoom();
    const actor = fullMember("alice");
    await runInDurableObject(stub, (_instance, state) => {
      const chat = new ChatModule(state.storage.sql);
      const results = Array.from({ length: 11 }, (_, index) =>
        chat.send({
          userId: actor.userId,
          body: `burst ${index}`,
          nonce: crypto.randomUUID(),
          members: [actor],
          now: 100,
        }),
      );

      expect(results.slice(0, 10).every((result) => result.ok)).toBe(true);
      expect(results[10]).toEqual({ ok: false, code: "rate_limited" });
      const row = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(`SELECT COUNT(*) AS count FROM messages`)
        .one();
      expect(Number(row["count"])).toBe(10);
    });
  });

  it("a rejected chat send leaves the socket usable", async () => {
    const stub = freshRoom();
    const actor = memberInit();
    await seed(stub, actor, {
      id: crypto.randomUUID(),
      nickname: "r",
      adminUserId: actor.userId,
    });

    const { ws, col } = await connect(stub, actor.userId);
    ws.send(
      JSON.stringify({
        t: "chat.send",
        body: "missing reply target",
        nonce: crypto.randomUUID(),
        replyToId: 999_999,
      }),
    );
    const err = await col.waitForType("error");
    expect(err.code).toBe("not_found");
    expect(col.count("chat.new")).toBe(0);

    // Socket stays open: a follow-up request is still served.
    requestHistory(ws, "latest");
    const page = await col.waitForType("chat.page");
    expect(page.messages).toHaveLength(0);
    ws.close();
  });
});

describe("message reactions", () => {
  it("persists shared counts, removes only the actor, and clears reactions on message deletion", async () => {
    const stub = freshRoom();
    const a = { ...memberInit(), displayName: "Alice" };
    const b = { ...memberInit(), displayName: "Bob" };
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, b, meta);
    const { ws: wsA, col: colA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);

    sendChat(wsA, "react here");
    const sent = await colA.waitForType("chat.new");
    await colB.waitForType("chat.new");
    expect(sent.message.reactions).toEqual([]);

    const requestA = setReaction(wsA, sent.message.id, "😀", true);
    await Promise.all([
      colA.waitForCount("chat.reaction.updated", 1),
      colB.waitForCount("chat.reaction.updated", 1),
    ]);
    const firstA = must(
      colA.messages.findLast(isType("chat.reaction.updated")),
      "A reaction update",
    );
    expect(firstA.requestId).toBe(requestA);
    expect(firstA.reaction?.reactors).toEqual([{ userId: a.userId, displayName: "Alice" }]);

    setReaction(wsB, sent.message.id, "😀", true);
    await Promise.all([
      colA.waitForCount("chat.reaction.updated", 2),
      colB.waitForCount("chat.reaction.updated", 2),
    ]);
    const shared = must(
      colA.messages.findLast(isType("chat.reaction.updated")),
      "shared reaction update",
    );
    expect(shared.reaction?.reactors).toEqual([
      { userId: a.userId, displayName: "Alice" },
      { userId: b.userId, displayName: "Bob" },
    ]);

    setReaction(wsA, sent.message.id, "😀", false);
    await colB.waitForCount("chat.reaction.updated", 3);
    const removedA = must(
      colB.messages.findLast(isType("chat.reaction.updated")),
      "remove reaction update",
    );
    expect(removedA.reaction?.reactors).toEqual([{ userId: b.userId, displayName: "Bob" }]);

    requestHistory(wsB, "latest");
    const page = await colB.waitForType("chat.page");
    expect(page.messages[0]?.reactions).toEqual([
      { emoji: "😀", reactors: [{ userId: b.userId, displayName: "Bob" }] },
    ]);

    wsA.send(
      JSON.stringify({
        t: "chat.delete",
        requestId: crypto.randomUUID(),
        messageId: sent.message.id,
      }),
    );
    const deleted = await colA.waitForType("chat.deleted");
    expect(deleted.message.reactions).toEqual([]);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?`,
          sent.message.id,
        )
        .one();
      expect(Number(row["count"])).toBe(0);
    });
    wsA.close();
    wsB.close();
  });

  it("keeps repeated desired state idempotent and validates emoji at the module boundary", async () => {
    const stub = freshRoom();
    await runInDurableObject(stub, (_instance, state) => {
      const chat = new ChatModule(state.storage.sql);
      const actor = fullMember("alice");
      const sent = chat.send({
        userId: actor.userId,
        body: "message",
        nonce: crypto.randomUUID(),
        members: [actor],
        now: 1,
      });
      if (!sent.ok) throw new Error("message send failed");

      const first = chat.setReaction({
        userId: actor.userId,
        displayName: actor.displayName,
        messageId: sent.message.id,
        emoji: "😀",
        reacted: true,
        now: 2,
      });
      const repeated = chat.setReaction({
        userId: actor.userId,
        displayName: actor.displayName,
        messageId: sent.message.id,
        emoji: "😀",
        reacted: true,
        now: 3,
      });
      const invalid = chat.setReaction({
        userId: actor.userId,
        displayName: actor.displayName,
        messageId: sent.message.id,
        emoji: "not emoji",
        reacted: true,
        now: 4,
      });
      const burstTail = Array.from({ length: 8 }, (_, index) =>
        chat.setReaction({
          userId: actor.userId,
          displayName: actor.displayName,
          messageId: sent.message.id,
          emoji: "😀",
          reacted: true,
          now: 5 + index,
        }),
      );
      const limited = chat.setReaction({
        userId: actor.userId,
        displayName: actor.displayName,
        messageId: sent.message.id,
        emoji: "😀",
        reacted: true,
        now: 13,
      });

      expect(first).toMatchObject({ ok: true, changed: true });
      expect(repeated).toMatchObject({ ok: true, changed: false });
      expect(invalid).toEqual({ ok: false, code: "bad_message" });
      expect(burstTail.every((result) => result.ok)).toBe(true);
      expect(limited).toEqual({ ok: false, code: "rate_limited" });
      const count = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(`SELECT COUNT(*) AS count FROM message_reactions`)
        .one();
      expect(Number(count["count"])).toBe(1);
    });
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

describe("paginated chat history and durable unread state", () => {
  it("loads 30 newest messages, then older pages without sending the entire history", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });
    await seedMessages(stub, a.userId, 55);

    const { ws, col } = await connect(stub, a.userId);
    requestHistory(ws, "latest");
    const page1 = await col.waitForType("chat.page");
    expect(page1.messages).toHaveLength(30);
    expect(page1.hasOlder).toBe(true);
    expect(page1.hasNewer).toBe(false);
    expect(page1.messages.map((m) => m.id)).toEqual(range(26, 55));

    const cursorId = must(page1.messages[0], "first message").id;
    requestHistory(ws, "older", cursorId);
    await col.waitForCount("chat.page", 2);
    const page2 = must(col.pages()[1], "second page");
    expect(page2.messages.map((m) => m.id)).toEqual(range(1, 25));
    expect(page2.hasOlder).toBe(false);
    expect(page2.hasNewer).toBe(true);
    ws.close();
  });

  it("limit over the schema max is rejected at the router (bad_message + close 1008)", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });

    const { ws, col } = await connect(stub, a.userId);
    ws.send(
      JSON.stringify({
        t: "chat.history",
        requestId: crypto.randomUUID(),
        mode: "initial",
        limit: 31,
      }),
    );
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
    expect(hello.lastReadMessageId).toBe(0);
    expect(hello.firstUnreadMessageId).toBeNull();
    expect(hello.unreadCount).toBe(0);
    ws.close();
  });

  it("initial history starts around a far-back durable unread cursor and can page both ways", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, b, meta);
    await seedMessages(stub, a.userId, 100);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO message_reads (user_id, last_read_id) VALUES (?, ?)`,
        b.userId,
        9,
      );
    });

    const { ws, col } = await connect(stub, b.userId);
    const hello = await col.waitForType("hello.ok");
    expect(hello.firstUnreadMessageId).toBe(10);
    expect(hello.unreadCount).toBe(91);
    requestHistory(ws, "initial");
    const page = await col.waitForType("chat.page");
    expect(page.messages.map((message) => message.id)).toEqual(range(1, 30));
    expect(page.hasOlder).toBe(false);
    expect(page.hasNewer).toBe(true);

    ws.send(JSON.stringify({ t: "chat.read", messageId: 20 }));
    const read = await col.waitForType("chat.read-state");
    expect(read.lastReadMessageId).toBe(20);
    expect(read.firstUnreadMessageId).toBe(21);
    expect(read.unreadCount).toBe(80);
    ws.close();
  });
});

describe("chat replies, edits, and deletes", () => {
  it("persists a reply preview, allows only the owner to delete, and leaves a tombstone", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, b, meta);
    const { ws: wsA, col: colA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);

    sendChat(wsA, "source");
    const source = await colA.waitForType("chat.new");
    wsB.send(
      JSON.stringify({
        t: "chat.send",
        body: "answer",
        nonce: crypto.randomUUID(),
        replyToId: source.message.id,
      }),
    );
    await colB.waitForCount("chat.new", 2);
    const reply = must(colB.messages.findLast(isType("chat.new")), "reply echo");
    expect(reply.message.reply).toMatchObject({
      id: source.message.id,
      body: "source",
      deleted: false,
    });

    wsB.send(
      JSON.stringify({
        t: "chat.delete",
        requestId: crypto.randomUUID(),
        messageId: source.message.id,
      }),
    );
    const forbidden = await colB.waitForType("error");
    expect(forbidden.code).toBe("forbidden");

    wsA.send(
      JSON.stringify({
        t: "chat.delete",
        requestId: crypto.randomUUID(),
        messageId: source.message.id,
      }),
    );
    const deleted = await colA.waitForType("chat.deleted");
    expect(deleted.message.body).toBe("");
    expect(deleted.message.deletedAt).toBeTypeOf("number");
    wsA.close();
    wsB.close();
  });

  it("edits only the owner's latest non-deleted message and marks it edited", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });
    const { ws, col } = await connect(stub, a.userId);
    sendChat(ws, "first");
    sendChat(ws, "second");
    await col.waitForCount("chat.new", 2);
    const own = col.messages.filter(isType("chat.new"));

    ws.send(
      JSON.stringify({
        t: "chat.edit",
        requestId: crypto.randomUUID(),
        messageId: must(own[0], "first").message.id,
        body: "cannot edit",
      }),
    );
    const forbidden = await col.waitForType("error");
    expect(forbidden.code).toBe("forbidden");

    ws.send(
      JSON.stringify({
        t: "chat.edit",
        requestId: crypto.randomUUID(),
        messageId: must(own[1], "second").message.id,
        body: "edited second",
      }),
    );
    const updated = await col.waitForType("chat.updated");
    expect(updated.message.body).toBe("edited second");
    expect(updated.message.editedAt).toBeTypeOf("number");
    ws.close();
  });

  it("deleting an image message removes its R2 object and cleanup intent", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const serverId = crypto.randomUUID();
    const imageId = crypto.randomUUID();
    await seed(stub, a, { id: serverId, nickname: "r", adminUserId: a.userId });
    await env.MEDIA.put(`${serverId}/chat-images/${imageId}.webp`, new Uint8Array([1, 2, 3]));
    const { ws, col } = await connect(stub, a.userId);
    ws.send(
      JSON.stringify({
        t: "chat.send",
        body: "",
        nonce: crypto.randomUUID(),
        image: { id: imageId, width: 20, height: 10 },
      }),
    );
    const sent = await col.waitForType("chat.new");
    ws.send(
      JSON.stringify({
        t: "chat.delete",
        requestId: crypto.randomUUID(),
        messageId: sent.message.id,
      }),
    );
    await col.waitForType("chat.deleted");

    expect(await env.MEDIA.get(`${serverId}/chat-images/${imageId}.webp`)).toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      const count = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(`SELECT COUNT(*) AS count FROM chat_image_cleanup`)
        .one();
      expect(Number(count["count"])).toBe(0);
    });
    ws.close();
  });
});
