import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { serverMessageSchema } from "@tavern/shared";
import type { MemberInit, ServerMessage } from "@tavern/shared";

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
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`rtc-${Date.now()}-${roomSeq}`));
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

class Collector {
  readonly messages: ServerMessage[] = [];

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const raw = event.data;
      if (typeof raw !== "string") return;
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw)));
    });
  }

  count<T extends ServerMessage["t"]>(t: T): number {
    return this.messages.filter(isType(t)).length;
  }

  async waitForType<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    return vi.waitFor(
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
}

async function connect(stub: RoomStub, userId: string): Promise<{ ws: WebSocket; col: Collector }> {
  const ws = await openSocket(stub, await mintTicket(stub, userId));
  const col = new Collector(ws);
  ws.send(HELLO);
  await col.waitForType("hello.ok");
  return { ws, col };
}

function metaFor(admin: string): RoomMeta {
  return { id: crypto.randomUUID(), nickname: "rtcroom", adminUserId: admin };
}

function monthNow(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

describe("FR-19 publish broadcast", () => {
  // NOTE (deviation, recorded in progress.md): the step's literal "publish mic:{uid} → stream.added"
  // is unimplementable against the pinned S0.2 StreamInfo (kind ∈ {screen,webcam} + a required preset;
  // the client `streams[]` canvas is video-only; mics ride voice.state). So the broadcast is exercised
  // with a StreamInfo-representable video publish (cam:{uid}); the mic publish is still registered
  // (asserted in rtc-proxy.test.ts) — preserving the "publish → peers receive stream.added" behavior.
  it("a member publishing a video stream → a second member's socket receives stream.added", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta = metaFor(a.userId);
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const { ws: wsA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);

    // A joins voice (so the publish authorize passes the in-voice gate), then publishes a webcam.
    wsA.send(JSON.stringify({ t: "voice.join" }));
    await colB.waitForType("voice.state");

    const res = await internalPost(stub, "/internal/rtc/authorize", {
      op: "publish",
      userId: a.userId,
      sessionId: "sess-a",
      tracks: [{ trackName: `cam:${a.userId}`, kind: "cam" }],
    });
    expect(await res.json()).toEqual({ ok: true });

    const added = await colB.waitForType("stream.added");
    expect(added.stream).toMatchObject({
      trackName: `cam:${a.userId}`,
      kind: "webcam",
      userId: a.userId,
      hasAudio: false,
    });

    wsA.close();
    wsB.close();
  });
});

describe("§8 G5 cost.warning delivery", () => {
  it("driving the meter past 700 GB delivers cost.warning to a voice member exactly once", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, metaFor(a.userId));
    const { ws, col } = await connect(stub, a.userId);

    // A is in voice with a LIVE socket → the alarm keeps them (not a ghost) and runs the meter tick.
    ws.send(JSON.stringify({ t: "voice.join" }));
    await col.waitForType("voice.state");

    // Seed this month's egress at the warn threshold; the next alarm tick crosses it.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO egress_log (month, bytes) VALUES (?, ?)`,
        monthNow(),
        700 * 1_000_000_000,
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const warning = await col.waitForType("cost.warning");
    expect(warning.usedGB).toBeGreaterThanOrEqual(700);
    expect(warning.capGB).toBe(900);

    // A second tick must NOT re-warn this month (idempotent).
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(col.count("cost.warning")).toBe(1);

    ws.close();
  });
});
