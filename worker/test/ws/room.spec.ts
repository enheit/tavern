import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  CLOSE_BAD_TICKET,
  CLOSE_KICKED,
  CLOSE_PROTOCOL_VIOLATION,
  serverMessageSchema,
} from "@tavern/shared";
import type { MemberInit, ServerMessage, UserProfile } from "@tavern/shared";

const BASE = "https://tavern.test";
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
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`room-${Date.now()}-${roomSeq}`));
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

function profileOf(member: MemberInit): UserProfile {
  return {
    userId: member.userId,
    username: member.username,
    displayName: member.displayName,
    color: member.color,
    ...(member.avatarKey === undefined ? {} : { avatarKey: member.avatarKey }),
  };
}

function internalPost(
  stub: RoomStub,
  path: string,
  body: unknown,
  opts?: { header?: boolean },
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.header !== false) headers["X-Tavern-Internal"] = "1";
  return stub.fetch(`https://do.internal${path}`, {
    method: "POST",
    headers,
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

// Opens (and client-accepts) a hibernatable socket via the DO stub upgrade path.
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

  presenceFor(userId: string): Array<Extract<ServerMessage, { t: "presence.update" }>> {
    return this.messages.filter(isType("presence.update")).filter((m) => m.userId === userId);
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

  async waitForCount(t: ServerMessage["t"], n: number): Promise<void> {
    await vi.waitFor(
      () => {
        if (this.count(t) < n) throw new Error(`awaiting ${n}× ${t}; have ${this.count(t)}`);
      },
      { timeout: 3000, interval: 25 },
    );
  }

  async waitForPresence(userId: string, presence: "online" | "offline"): Promise<void> {
    await vi.waitFor(
      () => {
        if (!this.presenceFor(userId).some((m) => m.presence === presence)) {
          throw new Error(`awaiting ${userId} ${presence}`);
        }
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

// ---- Through-Worker auth helpers (register → bearer; used only by the REST-path tests) ----
async function register(username: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
  if (!res.ok) throw new Error(`register ${username} failed: ${res.status}`);
  return must(res.headers.get("set-auth-token"), `no set-auth-token for ${username}`);
}

function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

async function createServer(token: string, nickname: string): Promise<string> {
  const res = await authed(token, "/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  const summary: { id: string } = await res.json();
  return summary.id;
}

describe("FR-45 presence & room lifecycle", () => {
  it("ticket is single-use: a second /ws with the same ticket closes 4002", async () => {
    const stub = freshRoom();
    const userId = crypto.randomUUID();
    const ticket = await mintTicket(stub, userId);

    const first = await openSocket(stub, ticket);
    const second = await openSocket(stub, ticket);
    const closed = await new Collector(second).waitForClose();
    expect(closed.code).toBe(CLOSE_BAD_TICKET);

    first.close();
    second.close();
  });

  it("expired ticket is rejected with close 4002", async () => {
    const stub = freshRoom();
    const userId = crypto.randomUUID();
    const ticket = crypto.randomUUID();
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(`ticket:${ticket}`, { userId, expiresAt: Date.now() - 1_000 });
    });

    const ws = await openSocket(stub, ticket);
    const closed = await new Collector(ws).waitForClose();
    expect(closed.code).toBe(CLOSE_BAD_TICKET);
    ws.close();
  });

  it("hello handshake replies hello.ok with self, seeded member, and pinned stubs", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const meta: RoomMeta = {
      id: crypto.randomUUID(),
      nickname: "tavern-room",
      adminUserId: a.userId,
    };
    await seed(stub, a, meta);

    const ws = await openSocket(stub, await mintTicket(stub, a.userId));
    const col = new Collector(ws);
    ws.send(HELLO);
    const hello = await col.waitForType("hello.ok");

    expect(hello.self.userId).toBe(a.userId);
    expect(hello.serverMeta).toEqual(meta);
    expect(hello.members.map((m) => m.userId)).toEqual([a.userId]);
    expect(hello.members[0]?.presence).toBe("online");
    expect(hello.voice).toEqual({ members: [], sessionStartedAt: null });
    expect(hello.streams).toEqual([]);
    expect(hello.recording).toEqual({ active: false });
    expect(hello.lastMessageId).toBe(0);
    expect(hello.costStatus).toEqual({ usedGB: 0, capGB: 900, blocked: false });
    ws.close();
  });

  it("first frame that is not hello → error bad_message then close 1008", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });

    const ws = await openSocket(stub, await mintTicket(stub, a.userId));
    const col = new Collector(ws);
    ws.send(JSON.stringify({ t: "voice.join" }));
    const err = await col.waitForType("error");
    expect(err.code).toBe("bad_message");
    expect((await col.waitForClose()).code).toBe(CLOSE_PROTOCOL_VIOLATION);
    ws.close();
  });

  it("malformed JSON frame after hello → close 1008", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });

    const ws = await openSocket(stub, await mintTicket(stub, a.userId));
    const col = new Collector(ws);
    ws.send(HELLO);
    await col.waitForType("hello.ok");
    ws.send("not json{");
    expect((await col.waitForClose()).code).toBe(CLOSE_PROTOCOL_VIOLATION);
    ws.close();
  });

  it("presence broadcasts only on 0↔1 transitions, observed by another member", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    // B is the observer.
    const wsB = await openSocket(stub, await mintTicket(stub, b.userId));
    const colB = new Collector(wsB);
    wsB.send(HELLO);
    await colB.waitForType("hello.ok");

    // A socket #1 → exactly one presence.update{online} for A reaches B. (B also saw its OWN online
    // on its 0→1 handshake — that is expected; presenceFor filters to A only.)
    const wsA1 = await openSocket(stub, await mintTicket(stub, a.userId));
    wsA1.send(HELLO);
    await colB.waitForPresence(a.userId, "online");
    expect(colB.presenceFor(a.userId)).toHaveLength(1);

    // A socket #2 → no new presence for A. Barrier (member.update) proves ordered delivery drained.
    const wsA2 = await openSocket(stub, await mintTicket(stub, a.userId));
    wsA2.send(HELLO);
    await internalPost(stub, "/internal/member-update", { profile: profileOf(b) });
    await colB.waitForCount("member.update", 1);
    expect(colB.presenceFor(a.userId)).toHaveLength(1);

    // Close socket #1 → A still has a live socket → still no offline.
    wsA1.close();
    await internalPost(stub, "/internal/member-update", { profile: profileOf(b) });
    await colB.waitForCount("member.update", 2);
    expect(colB.presenceFor(a.userId).map((m) => m.presence)).toEqual(["online"]);

    // Close socket #2 → last socket → offline.
    wsA2.close();
    await colB.waitForPresence(a.userId, "offline");
    expect(colB.presenceFor(a.userId).map((m) => m.presence)).toEqual(["online", "offline"]);
    wsB.close();
  });

  it("member.update is broadcast; kick emits member.left and closes the socket 4001", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta: RoomMeta = { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId };
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const wsA = await openSocket(stub, await mintTicket(stub, a.userId));
    const colA = new Collector(wsA);
    wsA.send(HELLO);
    await colA.waitForType("hello.ok");

    const wsB = await openSocket(stub, await mintTicket(stub, b.userId));
    const colB = new Collector(wsB);
    wsB.send(HELLO);
    await colB.waitForType("hello.ok");

    await internalPost(stub, "/internal/member-update", {
      profile: { ...profileOf(a), displayName: "Renamed" },
    });
    const update = await colB.waitForType("member.update");
    expect(update.profile).toMatchObject({ userId: a.userId, displayName: "Renamed" });

    // S2.2 changed the /internal/kick body to `{ userId, by }` (by = acting admin) + a 200 response.
    await internalPost(stub, "/internal/kick", { userId: a.userId, by: b.userId });
    const left = await colB.waitForType("member.left");
    expect(left.userId).toBe(a.userId);
    expect((await colA.waitForClose()).code).toBe(CLOSE_KICKED);
    wsB.close();
  });

  it("internal routes reject a request without X-Tavern-Internal (403)", async () => {
    const stub = freshRoom();
    const res = await internalPost(
      stub,
      "/internal/ticket",
      { userId: crypto.randomUUID() },
      {
        header: false,
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("hibernation registry holds N accepted sockets with round-tripping attachments", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, { id: crypto.randomUUID(), nickname: "r", adminUserId: a.userId });

    const N = 3;
    const sockets = await Promise.all(
      Array.from({ length: N }, async () => {
        const ws = await openSocket(stub, await mintTicket(stub, a.userId));
        const col = new Collector(ws);
        ws.send(HELLO);
        await col.waitForType("hello.ok");
        return ws;
      }),
    );

    await runInDurableObject(stub, (_instance, state) => {
      const registered = state.getWebSockets();
      expect(registered).toHaveLength(N);
      for (const ws of registered) {
        const attachment = ws.deserializeAttachment();
        expect(attachment).toMatchObject({ userId: a.userId, hello: true });
        expect(typeof attachment.connId).toBe("string");
      }
    });

    for (const ws of sockets) ws.close();
  });

  it("POST /api/ws-ticket issues a member ticket (hello.ok over the DO); non-member → 403", async () => {
    const token = await register("wsticketa");
    const serverId = await createServer(token, "wsticketroom");

    const res = await authed(token, "/api/ws-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId }),
    });
    expect(res.status).toBe(200);
    const { ticket }: { ticket: string } = await res.json();

    const stub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
    const ws = await openSocket(stub, ticket);
    const col = new Collector(ws);
    ws.send(HELLO);
    const hello = await col.waitForType("hello.ok");
    expect(hello.serverMeta.id).toBe(serverId);
    expect(hello.members.some((m) => m.userId === hello.self.userId)).toBe(true);
    ws.close();

    const outsider = await register("wsticketb");
    const denied = await authed(outsider, "/api/ws-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "not_member" });
  });

  it("GET /api/servers/:id/ws upgrades through the Worker and completes the handshake", async () => {
    const token = await register("wsupgrade");
    const serverId = await createServer(token, "wsupgraderoom");
    const tRes = await authed(token, "/api/ws-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId }),
    });
    const { ticket }: { ticket: string } = await tRes.json();

    const res = await SELF.fetch(`${BASE}/api/servers/${serverId}/ws?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const ws = must(res.webSocket, "expected webSocket in upgrade response");
    ws.accept();
    const col = new Collector(ws);
    ws.send(HELLO);
    const hello = await col.waitForType("hello.ok");
    expect(hello.serverMeta.id).toBe(serverId);
    ws.close();
  });
});
