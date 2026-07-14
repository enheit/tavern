import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, serverMessageSchema } from "@tavern/shared";
import type { ServerMessage } from "@tavern/shared";

const BASE = "https://tavern.test";
const HELLO = JSON.stringify({ t: "hello", proto: 1 });

type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function isType<T extends ServerMessage["t"]>(t: T) {
  return (m: ServerMessage): m is Extract<ServerMessage, { t: T }> => m.t === t;
}

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

async function meUserId(token: string): Promise<string> {
  const body: { user: { userId: string } } = await (await authed(token, "/api/me")).json();
  return body.user.userId;
}

async function createServer(token: string, nickname: string): Promise<string> {
  // Creation now requires a password + a one-time operator-seeded code (migration 0003); seed a fresh
  // code per create and use a fixed password (joinServer below matches it).
  const code = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO server_creation_codes (code, created_at) VALUES (?, ?)")
    .bind(code, Date.now())
    .run();
  const res = await authed(token, "/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname, password: "hunter2", code }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  const summary: { id: string } = await res.json();
  return summary.id;
}

async function joinServer(token: string, nickname: string): Promise<void> {
  // Servers created via the helper carry the fixed "hunter2" password, so join with it.
  const res = await authed(token, "/api/servers/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname, password: "hunter2" }),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
}

function roomStub(serverId: string): RoomStub {
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
}

class Collector {
  readonly messages: ServerMessage[] = [];
  private closed = false;

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      this.messages.push(serverMessageSchema.parse(JSON.parse(event.data)));
    });
    ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  count(pred: (m: ServerMessage) => boolean): number {
    return this.messages.filter(pred).length;
  }

  async waitFor<T extends ServerMessage["t"]>(
    t: T,
    pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    return vi.waitFor(
      () => {
        const found = this.messages.filter(isType(t)).find(pred);
        if (found === undefined) throw new Error(`awaiting ${t}`);
        return found;
      },
      { timeout: 3000, interval: 20 },
    );
  }

  isClosed(): boolean {
    return this.closed;
  }
}

async function openWs(serverId: string, token: string): Promise<{ ws: WebSocket; col: Collector }> {
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
  const ws = must(res.webSocket, "expected webSocket");
  ws.accept();
  const col = new Collector(ws);
  ws.send(HELLO);
  await col.waitFor("hello.ok");
  return { ws, col };
}

async function joinVoice(ws: WebSocket, col: Collector, userId: string): Promise<void> {
  ws.send(JSON.stringify({ t: "voice.join", mediaReadyVersion: 2 }));
  await col.waitFor("voice.state", (m) => m.voice.members.some((mem) => mem.userId === userId));
}

describe("FR-25 recording state machine", () => {
  it("rec.start while not in voice → not_in_voice", async () => {
    const token = await register("rec_st_a");
    const serverId = await createServer(token, "rec-st-a");
    const { ws, col } = await openWs(serverId, token);

    ws.send(JSON.stringify({ t: "rec.start" }));
    const err = await col.waitFor("error");
    expect(err.code).toBe("not_in_voice");
    expect(col.count(isType("rec.state"))).toBe(0);
    ws.close();
  });

  it("rec.start creates row, broadcasts active rec.state, appends activity rec.start", async () => {
    const token = await register("rec_st_b");
    const uid = await meUserId(token);
    const serverId = await createServer(token, "rec-st-b");
    const { ws, col } = await openWs(serverId, token);
    await joinVoice(ws, col, uid);

    ws.send(JSON.stringify({ t: "rec.start" }));
    const state = await col.waitFor("rec.state", (m) => m.recording.active);
    expect(state.recording.active).toBe(true);
    if (state.recording.active) expect(state.recording.startedBy).toBe(uid);
    const activity = await col.waitFor("activity.new", (m) => m.entry.type === "rec.start");
    expect(activity.entry.userId).toBe(uid);

    const rows = await runInDurableObject(roomStub(serverId), (_i, s) =>
      s.storage.sql.exec("SELECT COUNT(*) AS n FROM recordings").one(),
    );
    expect(rows["n"]).toBe(1);
    ws.close();
  });

  it("second rec.start → already_recording", async () => {
    const token = await register("rec_st_c");
    const uid = await meUserId(token);
    const serverId = await createServer(token, "rec-st-c");
    const { ws, col } = await openWs(serverId, token);
    await joinVoice(ws, col, uid);

    ws.send(JSON.stringify({ t: "rec.start" }));
    await col.waitFor("rec.state", (m) => m.recording.active);
    ws.send(JSON.stringify({ t: "rec.start" }));
    const err = await col.waitFor("error");
    expect(err.code).toBe("already_recording");
    ws.close();
  });

  it("rec.stop broadcasts inactive; complete finalizes row with duration capped at recordingMaxDurationMs", async () => {
    const token = await register("rec_st_d");
    const uid = await meUserId(token);
    const serverId = await createServer(token, "rec-st-d");
    const { ws, col } = await openWs(serverId, token);
    await joinVoice(ws, col, uid);

    ws.send(JSON.stringify({ t: "rec.start" }));
    await col.waitFor("rec.state", (m) => m.recording.active);

    // Open + one final part via REST while recording (the sink opens lazily on the first part).
    const openRes = await authed(token, `/api/servers/${serverId}/recordings`, { method: "POST" });
    const { recordingId, uploadId }: { recordingId: string; uploadId: string } =
      await openRes.json();
    const part = await authed(
      token,
      `/api/servers/${serverId}/recordings/${recordingId}/part?n=1&uploadId=${encodeURIComponent(uploadId)}&final=1`,
      { method: "PUT", body: new Uint8Array(64).fill(3) },
    );
    const { etag }: { etag: string } = await part.json();

    // rec.stop flips state inactive immediately (before finalize).
    ws.send(JSON.stringify({ t: "rec.stop" }));
    await col.waitFor("rec.state", (m) => !m.recording.active);
    await col.waitFor("activity.new", (m) => m.entry.type === "rec.stop");

    // complete with a duration OVER the cap → finalize clamps to recordingMaxDurationMs.
    const complete = await authed(
      token,
      `/api/servers/${serverId}/recordings/${recordingId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ partNumber: 1, etag }],
          durationMs: LIMITS.recordingMaxDurationMs + 5_000_000,
        }),
      },
    );
    expect(complete.status).toBe(204);

    const list = await authed(token, `/api/servers/${serverId}/recordings`);
    const body: { recordings: Array<{ id: string; durationMs: number | null }> } =
      await list.json();
    expect(body.recordings.find((r) => r.id === recordingId)?.durationMs).toBe(
      LIMITS.recordingMaxDurationMs,
    );
    ws.close();
  });

  it("starter disconnect while active → row deleted, multipart aborted, inactive broadcast, activity meta aborted", async () => {
    const aToken = await register("rec_st_e_a");
    const aId = await meUserId(aToken);
    const serverId = await createServer(aToken, "rec-st-e");
    const bToken = await register("rec_st_e_b");
    await joinServer(bToken, "rec-st-e");

    const a = await openWs(serverId, aToken);
    const b = await openWs(serverId, bToken); // observer, not in voice
    await joinVoice(a.ws, a.col, aId);

    a.ws.send(JSON.stringify({ t: "rec.start" }));
    await b.col.waitFor("rec.state", (m) => m.recording.active);
    // Open the multipart so the dirty-end path exercises the real R2 abort.
    await authed(aToken, `/api/servers/${serverId}/recordings`, { method: "POST" });

    // A's only socket closes. Expiring its reconnect lease drives leaveVoice and the dirty end.
    a.ws.close();
    await vi.waitFor(async () => {
      const deadline = await runInDurableObject(roomStub(serverId), async (_i, state) => {
        const leases = await state.storage.get<Record<string, number>>("voice:disconnects");
        return leases?.[aId];
      });
      expect(deadline).toBeTypeOf("number");
    });
    await runInDurableObject(roomStub(serverId), async (_i, state) => {
      await state.storage.put("voice:disconnects", { [aId]: 0 });
    });
    await runDurableObjectAlarm(roomStub(serverId));

    await b.col.waitFor("rec.state", (m) => !m.recording.active);
    const aborted = await b.col.waitFor(
      "activity.new",
      (m) => m.entry.type === "rec.stop" && m.entry.meta["aborted"] === true,
    );
    expect(aborted.entry.userId).toBe(aId);

    const row = await runInDurableObject(roomStub(serverId), (_i, s) =>
      s.storage.sql.exec("SELECT COUNT(*) AS n FROM recordings").one(),
    );
    expect(row["n"]).toBe(0);
    const control = await runInDurableObject(roomStub(serverId), (_i, s) =>
      s.storage.get("recording"),
    );
    expect(control).toBeUndefined();
    b.ws.close();
  });

  it("alarm/idempotency: repeated dirty-end handling does not double-append activity", async () => {
    const token = await register("rec_st_f");
    const uid = await meUserId(token);
    const serverId = await createServer(token, "rec-st-f");
    const stub = roomStub(serverId);
    const recordingId = crypto.randomUUID();

    // Seed a GHOST recorder: in voice + active recording pointer, but NO live socket (a crash the
    // alarm reconciles). Two alarm fires (DO alarms are at-least-once) must abort + append exactly once.
    await runInDurableObject(stub, async (_i, s) => {
      await s.storage.put("voice", {
        members: [{ userId: uid, muted: false, deafened: false }],
        sessionStartedAt: Date.now(),
      });
      await s.storage.put("voice:disconnects", { [uid]: 0 });
      s.storage.sql.exec(
        `INSERT INTO recordings (id, started_by, r2_key, upload_id, duration_ms, started_at, ended_at)
         VALUES (?, ?, ?, NULL, NULL, ?, NULL)`,
        recordingId,
        uid,
        `recordings/${serverId}/${recordingId}.webm`,
        Date.now(),
      );
      await s.storage.put("recording", { recordingId, startedBy: uid, startedAt: Date.now() });
      await s.storage.setAlarm(Date.now() + 10);
    });

    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);

    const abortedCount = await runInDurableObject(stub, (_i, s) =>
      s.storage.sql.exec("SELECT COUNT(*) AS n FROM activity WHERE type = 'rec.stop'").one(),
    );
    expect(abortedCount["n"]).toBe(1);
  });
});
