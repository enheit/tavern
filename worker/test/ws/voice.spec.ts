import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { serverMessageSchema } from "@tavern/shared";
import type { MemberInit, ServerMessage, VoiceState } from "@tavern/shared";
import { StatsModule } from "../../src/do/stats";

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
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`voice-${Date.now()}-${roomSeq}`));
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

// Buffers every inbound (validated) frame, with retry-based waiters.
class Collector {
  readonly messages: ServerMessage[] = [];

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const raw = event.data;
      if (typeof raw !== "string") return;
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw)));
    });
  }

  voiceStates(): Array<Extract<ServerMessage, { t: "voice.state" }>> {
    return this.messages.filter(isType("voice.state"));
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

  // Waits until the LATEST voice.state snapshot satisfies `pred` (state converges to the assertion).
  async waitForVoice(pred: (v: VoiceState) => boolean): Promise<VoiceState> {
    return await vi.waitFor(
      () => {
        const states = this.voiceStates();
        const last = states.at(-1);
        if (last === undefined || !pred(last.voice)) {
          throw new Error(`awaiting voice state; have ${states.length}`);
        }
        return last.voice;
      },
      { timeout: 3000, interval: 25 },
    );
  }

  async waitForActivity(type: string): Promise<Extract<ServerMessage, { t: "activity.new" }>> {
    return await vi.waitFor(
      () => {
        const found = this.messages
          .filter(isType("activity.new"))
          .find((m) => m.entry.type === type);
        if (found === undefined) throw new Error(`awaiting activity ${type}`);
        return found;
      },
      { timeout: 3000, interval: 25 },
    );
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

function metaFor(admin: string): RoomMeta {
  return { id: crypto.randomUUID(), nickname: "voiceroom", adminUserId: admin };
}

function flagsOf(v: VoiceState, userId: string): { muted: boolean; deafened: boolean } | undefined {
  const member = v.members.find((m) => m.userId === userId);
  return member === undefined ? undefined : { muted: member.muted, deafened: member.deafened };
}

describe("FR-18 voice join/leave", () => {
  it("A joins → all sockets get the snapshot + timer; B joins → 2; double-join is a no-op", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta = metaFor(a.userId);
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const { ws: wsA, col: colA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);

    // A joins → both A's and B's sockets receive voice.state with A + a live session timer (FR-24).
    wsA.send(JSON.stringify({ t: "voice.join" }));
    const afterAJoin = await colB.waitForVoice((v) => v.members.length === 1);
    expect(afterAJoin.members.map((m) => m.userId)).toEqual([a.userId]);
    expect(afterAJoin.sessionStartedAt).not.toBeNull();
    const aSelfView = await colA.waitForVoice((v) => v.members.length === 1);
    expect(aSelfView.members[0]?.userId).toBe(a.userId);

    // B joins → snapshot has both members.
    wsB.send(JSON.stringify({ t: "voice.join" }));
    const afterBJoin = await colB.waitForVoice((v) => v.members.length === 2);
    expect(afterBJoin.members.map((m) => m.userId).toSorted()).toEqual(
      [a.userId, b.userId].toSorted(),
    );

    // Double-join from B → still exactly 2, B not duplicated (idempotent no-op).
    const beforeCount = colB.voiceStates().length;
    wsB.send(JSON.stringify({ t: "voice.join" }));
    await vi.waitFor(() => {
      if (colB.voiceStates().length <= beforeCount) throw new Error("awaiting no-op snapshot");
    });
    const latest = must(colB.voiceStates().at(-1), "voice state").voice;
    expect(latest.members).toHaveLength(2);
    expect(new Set(latest.members.map((m) => m.userId)).size).toBe(2);

    wsA.close();
    wsB.close();
  });

  it("A's last socket hard-closes → snapshot without A + a voice.leave activity", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta = metaFor(a.userId);
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const { ws: wsA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);

    wsA.send(JSON.stringify({ t: "voice.join" }));
    await colB.waitForVoice((v) => v.members.some((m) => m.userId === a.userId));

    // A's socket drops → B sees A removed from voice + a synthesized voice.leave activity entry.
    wsA.close();
    const gone = await colB.waitForVoice((v) => v.members.length === 0);
    expect(gone.members).toEqual([]);
    const leave = await colB.waitForActivity("voice.leave");
    expect(leave.entry.userId).toBe(a.userId);

    wsB.close();
  });
});

describe("FR-24 session timer & auto-close", () => {
  it("first join opens a voice_sessions row and arms an alarm", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, metaFor(a.userId));
    const { ws, col } = await connect(stub, a.userId);

    ws.send(JSON.stringify({ t: "voice.join" }));
    await col.waitForVoice((v) => v.members.length === 1 && v.sessionStartedAt !== null);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      const rows = state.storage.sql
        .exec<{ started_at: number; ended_at: number | null }>(
          `SELECT started_at, ended_at FROM voice_sessions`,
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ended_at).toBeNull();
    });
    ws.close();
  });

  it("last leave sets ended_at and nulls sessionStartedAt", async () => {
    const stub = freshRoom();
    const a = memberInit();
    await seed(stub, a, metaFor(a.userId));
    const { ws, col } = await connect(stub, a.userId);

    ws.send(JSON.stringify({ t: "voice.join" }));
    await col.waitForVoice((v) => v.members.length === 1);
    ws.send(JSON.stringify({ t: "voice.leave" }));
    await col.waitForVoice((v) => v.members.length === 0);

    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ ended_at: number | null }>(`SELECT ended_at FROM voice_sessions`)
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ended_at).not.toBeNull();
      const voice = await state.storage.get<VoiceState>("voice");
      expect(voice?.sessionStartedAt).toBeNull();
      expect(voice?.members).toEqual([]);
    });
    ws.close();
  });

  it("GHOST: the alarm reconciles a crash-leftover voice member (closes session + voice.leave)", async () => {
    const stub = freshRoom();
    const ghostId = crypto.randomUUID();
    const base = Date.now() - 90_000;

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("voice", {
        members: [{ userId: ghostId, muted: false, deafened: false }],
        sessionStartedAt: base,
      });
      state.storage.sql.exec(
        `INSERT INTO voice_sessions (channel_id, started_at) VALUES ('main', ?)`,
        base,
      );
      // A real ghost still has the join-armed alarm pending; model that so the alarm fires. Future
      // time so ONLY the explicit runDurableObjectAlarm fires it (a past time races the scheduler).
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      const voice = await state.storage.get<VoiceState>("voice");
      expect(voice?.members).toEqual([]);
      expect(voice?.sessionStartedAt).toBeNull();
      const session = state.storage.sql
        .exec<{ ended_at: number | null }>(`SELECT ended_at FROM voice_sessions`)
        .one();
      expect(session.ended_at).not.toBeNull();
      const leaves = state.storage.sql
        .exec<{ user_id: string }>(`SELECT user_id FROM activity WHERE type = 'voice.leave'`)
        .toArray();
      expect(leaves).toHaveLength(1);
      expect(leaves[0]?.user_id).toBe(ghostId);
    });
  });

  it("a double alarm fire does not double-close the session or duplicate stats (idempotency)", async () => {
    const stub = freshRoom();
    const ghostId = crypto.randomUUID();
    const base = Date.now() - 90_000;

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("voice", {
        members: [{ userId: ghostId, muted: false, deafened: false }],
        sessionStartedAt: base,
      });
      state.storage.sql.exec(
        `INSERT INTO voice_sessions (channel_id, started_at) VALUES ('main', ?)`,
        base,
      );
      // The ghost was mid-stream when it crashed → an open stream interval to be swept exactly once.
      await state.storage.put("stats:open", { streams: { [ghostId]: base }, watches: {} });
      // A real ghost still has the join-armed alarm pending; model that so the alarm fires. Future
      // time so ONLY the explicit runDurableObjectAlarm fires it (a past time races the scheduler).
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after1 = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ seconds: number }>(
          `SELECT seconds FROM stat_stream_seconds WHERE user_id = ?`,
          ghostId,
        )
        .toArray()[0];
      return row === undefined ? 0 : Number(row.seconds);
    });
    expect(after1).toBeGreaterThan(0);

    // Force a second fire; the ghost is already gone, so it must be a pure no-op.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ seconds: number }>(
          `SELECT seconds FROM stat_stream_seconds WHERE user_id = ?`,
          ghostId,
        )
        .toArray()[0];
      expect(row === undefined ? 0 : Number(row.seconds)).toBe(after1);
      const sessions = state.storage.sql
        .exec<{ ended_at: number | null }>(`SELECT ended_at FROM voice_sessions`)
        .toArray();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.ended_at).not.toBeNull();
      const leaves = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM activity WHERE type = 'voice.leave'`)
        .one();
      expect(Number(leaves.n)).toBe(1);
    });
  });
});

describe("FR-26 flags relay", () => {
  it("relays self mute then deafen into the broadcast snapshot", async () => {
    const stub = freshRoom();
    const a = memberInit();
    const b = memberInit();
    const meta = metaFor(a.userId);
    await seed(stub, a, meta);
    await seed(stub, b, meta);

    const { ws: wsA } = await connect(stub, a.userId);
    const { ws: wsB, col: colB } = await connect(stub, b.userId);

    wsA.send(JSON.stringify({ t: "voice.join" }));
    await colB.waitForVoice((v) => v.members.some((m) => m.userId === a.userId));

    wsA.send(JSON.stringify({ t: "voice.state", muted: true, deafened: false }));
    const muted = await colB.waitForVoice((v) => flagsOf(v, a.userId)?.muted === true);
    expect(flagsOf(muted, a.userId)).toEqual({ muted: true, deafened: false });

    wsA.send(JSON.stringify({ t: "voice.state", muted: true, deafened: true }));
    const deafened = await colB.waitForVoice((v) => flagsOf(v, a.userId)?.deafened === true);
    expect(flagsOf(deafened, a.userId)).toEqual({ muted: true, deafened: true });

    wsA.close();
    wsB.close();
  });
});

describe("FR-40 stat accumulators", () => {
  it("watch seconds accrue exactly across a mid-session flush plus the final stop", async () => {
    const stub = freshRoom();
    const viewer = crypto.randomUUID();
    const streamer = crypto.randomUUID();
    const t0 = 1_700_000_000_000;

    await runInDurableObject(stub, async (_instance, state) => {
      const stats = new StatsModule(state);
      await stats.noteWatchStart(viewer, streamer, t0);
      await stats.flushOpenIntervals(t0 + 90_000);
      await stats.noteWatchStop(viewer, streamer, t0 + 120_000);
      const row = state.storage.sql
        .exec<{ seconds: number }>(
          `SELECT seconds FROM stat_watch_seconds WHERE viewer_id = ? AND streamer_id = ?`,
          viewer,
          streamer,
        )
        .one();
      expect(Number(row.seconds)).toBe(120);
    });
  });

  it("stream seconds are exact for a single start/stop", async () => {
    const stub = freshRoom();
    const uid = crypto.randomUUID();
    const t0 = 1_700_000_000_000;

    await runInDurableObject(stub, async (_instance, state) => {
      const stats = new StatsModule(state);
      await stats.noteStreamStart(uid, t0);
      await stats.noteStreamStop(uid, t0 + 45_000);
      const row = state.storage.sql
        .exec<{ seconds: number }>(`SELECT seconds FROM stat_stream_seconds WHERE user_id = ?`, uid)
        .one();
      expect(Number(row.seconds)).toBe(45);
    });
  });

  it("closeAllFor closes both the user's stream and watch intervals", async () => {
    const stub = freshRoom();
    const uid = crypto.randomUUID();
    const streamer = crypto.randomUUID();
    const t0 = 1_700_000_000_000;

    await runInDurableObject(stub, async (_instance, state) => {
      const stats = new StatsModule(state);
      await stats.noteStreamStart(uid, t0);
      await stats.noteWatchStart(uid, streamer, t0);
      await stats.closeAllFor(uid, t0 + 60_000);

      const stream = state.storage.sql
        .exec<{ seconds: number }>(`SELECT seconds FROM stat_stream_seconds WHERE user_id = ?`, uid)
        .one();
      expect(Number(stream.seconds)).toBe(60);
      const watch = state.storage.sql
        .exec<{ seconds: number }>(
          `SELECT seconds FROM stat_watch_seconds WHERE viewer_id = ? AND streamer_id = ?`,
          uid,
          streamer,
        )
        .one();
      expect(Number(watch.seconds)).toBe(60);
      expect(await stats.hasOpenIntervals()).toBe(false);
    });
  });

  it("flush with no open intervals is a no-op", async () => {
    const stub = freshRoom();
    const t0 = 1_700_000_000_000;

    await runInDurableObject(stub, async (_instance, state) => {
      const stats = new StatsModule(state);
      await stats.flushOpenIntervals(t0);
      const streamRows = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM stat_stream_seconds`)
        .one();
      const watchRows = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM stat_watch_seconds`)
        .one();
      expect(Number(streamRows.n)).toBe(0);
      expect(Number(watchRows.n)).toBe(0);
      expect(await stats.hasOpenIntervals()).toBe(false);
    });
  });
});
