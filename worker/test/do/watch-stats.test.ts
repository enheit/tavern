import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MeResponse, StatsResponse } from "@tavern/shared";
import { CostMeter } from "../../src/do/costMeter";
import { StatsModule } from "../../src/do/stats";

// FR-40 per-user stats (per server): hours streamed + hours watched broken down per (viewer→streamer)
// pair, SERVER-AUTHORITATIVE — the DO accrues from its OWN watch/stream events (never client-reported).
// The accumulators (S3.4) take an explicit clock; here we drive them exactly as the ServerRoom
// watch.start/stop + stream.start/stop + disconnect handlers do, and read the result via the same
// snapshot the HTTP `GET /api/servers/:id/stats` returns.
const BASE = "https://tavern.test";
type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

let roomSeq = 0;
function freshRoom(): RoomStub {
  roomSeq += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`watch-stats-${Date.now()}-${roomSeq}`));
}

async function register(username: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
  if (!res.ok) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
  return must(res.headers.get("set-auth-token"), `no set-auth-token for ${username}`);
}

function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

async function meUserId(token: string): Promise<string> {
  const body = MeResponse.parse(await (await authed(token, "/api/me")).json());
  return body.user.userId;
}

async function createServer(token: string, nickname: string): Promise<string> {
  // Creation now requires a password + a one-time operator-seeded code (migration 0003); seed a fresh
  // code per create and use a fixed password.
  const code = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO server_creation_codes (code, created_at) VALUES (?, ?)")
    .bind(code, Date.now())
    .run();
  const res = await authed(token, "/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname, password: "hunter2", code }),
  });
  if (res.status !== 201) throw new Error(`create: ${res.status} ${await res.text()}`);
  const summary: { id: string } = await res.json();
  return summary.id;
}

const T0 = 1_700_000_000_000;

describe("FR-40 watch/stream seconds", () => {
  it("grant→release accrues pair seconds server-side", async () => {
    const viewer = crypto.randomUUID();
    const streamer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const stats = new StatsModule(state);
      // watch.start → watch.stop, 90 s apart (injected clock).
      await stats.noteWatchStart(viewer, streamer, T0);
      await stats.noteWatchStop(viewer, streamer, T0 + 90_000);
      const snap = stats.snapshot(new Map(), []);
      expect(snap.watchPairs).toContainEqual({
        viewerId: viewer,
        streamerId: streamer,
        seconds: 90,
      });
    });
  });

  it("disconnect closes open watch intervals (nothing left open, seconds banked)", async () => {
    const viewer = crypto.randomUUID();
    const streamer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const stats = new StatsModule(state);
      const meter = new CostMeter(state, {});
      // Viewer opens a watch (stat clock + metered pull), then disconnects (leaveVoice sweep).
      await stats.noteWatchStart(viewer, streamer, T0);
      await meter.openWatch(viewer, `screen:${streamer}:1`, "720p30", "l", T0);
      expect(await stats.hasOpenIntervals()).toBe(true);

      await stats.closeAllFor(viewer, T0 + 30_000);
      await meter.closeWatchesForViewer(viewer, T0 + 30_000);

      // No open intervals remain; the 30 s watch was banked to the pair.
      expect(await stats.hasOpenIntervals()).toBe(false);
      const snap = stats.snapshot(new Map(), []);
      expect(snap.watchPairs).toContainEqual({
        viewerId: viewer,
        streamerId: streamer,
        seconds: 30,
      });
    });
  });

  it("stream stop accrues streamer seconds", async () => {
    const streamer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const stats = new StatsModule(state);
      await stats.noteStreamStart(streamer, T0);
      await stats.noteStreamStop(streamer, T0 + 45_000);
      const snap = stats.snapshot(new Map(), []);
      expect(snap.perUser).toContainEqual({ userId: streamer, messages: 0, streamSeconds: 45 });
    });
  });

  it("GET /api/servers/:id/stats reflects both stream seconds and watch pairs", async () => {
    const token = await register("watchstats_owner");
    const ownerId = await meUserId(token);
    const serverId = await createServer(token, "watchstatsroom");
    const streamer = crypto.randomUUID();

    // Accrue via the same accumulators the WS handlers feed, straight into the server's DO.
    const stub: RoomStub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
    await runInDurableObject(stub, async (_i, state) => {
      const stats = new StatsModule(state);
      await stats.noteStreamStart(streamer, T0);
      await stats.noteStreamStop(streamer, T0 + 120_000); // 120 s streamed
      await stats.noteWatchStart(ownerId, streamer, T0);
      await stats.noteWatchStop(ownerId, streamer, T0 + 75_000); // 75 s watched
    });

    const res = await authed(token, `/api/servers/${serverId}/stats`);
    expect(res.status).toBe(200);
    const snap = StatsResponse.parse(await res.json());
    expect(snap.perUser).toContainEqual({ userId: streamer, messages: 0, streamSeconds: 120 });
    expect(snap.watchPairs).toContainEqual({
      viewerId: ownerId,
      streamerId: streamer,
      seconds: 75,
    });
  });
});
