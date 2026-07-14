import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ActivityPage, LIMITS, TavernHomeResponse } from "@tavern/shared";
import { ActivityModule } from "../src/do/activity";
import { HangoutsModule } from "../src/do/hangouts";

const BASE = "https://tavern.test";

// Typed stub so runInDurableObject infers the ServerRoom instance (its O must extend DurableObject).
type RoomStub = DurableObjectStub<import("../src/do/ServerRoom").ServerRoom>;

// Non-null narrow without `!` (§9.1).
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// Register a fresh account (register replies with set-auth-token, so no rate-limited sign-in is
// needed) and return its bearer token.
async function register(username: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
  if (!res.ok) throw new Error(`register ${username} failed: ${res.status} ${await res.text()}`);
  return must(res.headers.get("set-auth-token"), `no set-auth-token for ${username}`);
}

function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
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
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const summary: { id: string } = await res.json();
  return summary.id;
}

// Clears the server-create `member.join` entry and seeds exactly `count` fresh rows through the real
// ActivityModule (ids strictly increasing via AUTOINCREMENT; created_at strictly increasing).
async function seedActivity(serverId: string, count: number): Promise<void> {
  const stub: RoomStub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM activity`);
    const activity = new ActivityModule(state.storage.sql);
    const base = Date.now();
    for (let i = 0; i < count; i += 1) {
      activity.append("member.join", crypto.randomUUID(), {}, base + i);
    }
  });
}

describe("FR-39 activity read", () => {
  it("paginates newest-first using the shared page size", async () => {
    const token = await register("activityreader");
    const serverId = await createServer(token, "activityroom");
    await seedActivity(serverId, 55);

    const res1 = await authed(
      token,
      `/api/servers/${serverId}/activity?limit=${LIMITS.historyPageSize}`,
    );
    expect(res1.status).toBe(200);
    const page1 = ActivityPage.parse(await res1.json());
    expect(page1.entries).toHaveLength(LIMITS.historyPageSize);
    expect(page1.hasMore).toBe(true);
    // Entries are oldest→newest within the page, so entries[0] is the oldest of the newest 50.
    const before = must(page1.entries[0], "first entry").id;

    const res2 = await authed(
      token,
      `/api/servers/${serverId}/activity?before=${before}&limit=${LIMITS.historyPageSize}`,
    );
    expect(res2.status).toBe(200);
    const page2 = ActivityPage.parse(await res2.json());
    expect(page2.entries).toHaveLength(55 - LIMITS.historyPageSize);
    expect(page2.hasMore).toBe(false);
    // The two pages together are the full, non-overlapping 55-row log (ids strictly ascending).
    const ids = [...page2.entries, ...page1.entries].map((e) => e.id);
    expect(ids).toHaveLength(55);
    expect(new Set(ids).size).toBe(55);
    expect(ids.toSorted((x, y) => x - y)).toEqual(ids);
  });

  it("defaults the limit to the page size when omitted", async () => {
    const token = await register("activitydefault");
    const serverId = await createServer(token, "activitydefaultroom");
    await seedActivity(serverId, 55);

    const res = await authed(token, `/api/servers/${serverId}/activity`);
    expect(res.status).toBe(200);
    const page = ActivityPage.parse(await res.json());
    expect(page.entries).toHaveLength(LIMITS.historyPageSize);
    expect(page.hasMore).toBe(true);
  });

  it("rejects a non-numeric pagination query with 400 bad_request", async () => {
    const token = await register("activitybadq");
    const serverId = await createServer(token, "activitybadqroom");

    const res = await authed(token, `/api/servers/${serverId}/activity?limit=abc`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("a non-member is denied with 403", async () => {
    const owner = await register("activityowner");
    const serverId = await createServer(owner, "activityownerroom");
    await seedActivity(serverId, 3);

    const outsider = await register("activityoutsider");
    const res = await authed(outsider, `/api/servers/${serverId}/activity`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });
  });
});

describe("Tavern Home read", () => {
  it("returns a bounded recap projected from hangouts and existing media", async () => {
    const token = await register("homereader");
    const serverId = await createServer(token, "homereaderroom");
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const screenshotId = crypto.randomUUID();
    const recordingId = crypto.randomUUID();
    const soundId = crypto.randomUUID();
    const base = Date.now() - 1_000_000;
    const stub: RoomStub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));

    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const hangouts = new HangoutsModule(sql);
      hangouts.noteVoiceChange([a], [a, b], base);
      hangouts.noteVoiceChange([a, b], [], base + 120_000);
      hangouts.finalizeDue(base + 200_000);
      sql.exec(
        `INSERT INTO screenshots(id, captured_by, r2_key, created_at) VALUES (?, ?, ?, ?)`,
        screenshotId,
        a,
        `screenshots/${screenshotId}.webp`,
        base + 300_000,
      );
      sql.exec(
        `INSERT INTO recordings(id, started_by, r2_key, duration_ms, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        recordingId,
        b,
        `recordings/${recordingId}.webm`,
        60_000,
        base + 400_000,
        base + 460_000,
      );
      sql.exec(
        `INSERT INTO sounds(
           id, name, emoji, gain, source_file_name, uploader_id, r2_key,
           duration_ms, trim_start_ms, trim_end_ms, created_at)
         VALUES (?, 'cheers', '🔊', 1, 'cheers.mp3', ?, ?, 1000, 0, 1000, ?)`,
        soundId,
        a,
        `sounds/${soundId}.mp3`,
        base + 500_000,
      );
    });

    const res = await authed(token, `/api/servers/${serverId}/home`);
    expect(res.status).toBe(200);
    const home = TavernHomeResponse.parse(await res.json());
    expect(home.recentHangouts).toHaveLength(1);
    expect(home.recentHangouts[0]?.participantIds).toEqual([a, b].toSorted());
    expect(home.pointLeaderboard).toHaveLength(1);
    expect(home.pointLeaderboard[0]?.balance).toBe(0);
    expect(home.latestScreenshot?.id).toBe(screenshotId);
    expect(home.latestRecording?.id).toBe(recordingId);
    expect(home.latestSound?.id).toBe(soundId);
  });

  it("denies a non-member", async () => {
    const owner = await register("homeowner");
    const serverId = await createServer(owner, "homeownerroom");
    const outsider = await register("homeoutsider");

    const res = await authed(outsider, `/api/servers/${serverId}/home`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });
  });
});
