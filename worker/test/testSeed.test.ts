import {
  createExecutionContext,
  env,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { RoomState } from "../src/do/roomState";
import type { RtcRegistry } from "../src/do/roomState";
import { resetSfuMock } from "../src/rtc/realtimeMock";

// S8.5 test-only seed route (PLAN §10). `POST /api/__test/seed-shares` registers synthetic active
// screen shares in a server's DO RTC registry so the streams e2e can exercise the G4 concurrent-share
// cap without publishing real media. The route is mounted behind a router-assembly env guard
// (TAVERN_SFU_MOCK=1): the pool-workers env sets that flag (worker/vitest.config.ts), so SELF.fetch
// reaches the route; the 404-when-absent guard is proven by invoking the app with the flag removed.

const BASE = "https://tavern.test";

type RoomStub = DurableObjectStub<import("../src/do/ServerRoom").ServerRoom>;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function roomStub(serverId: string): RoomStub {
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
}

async function readRegistry(serverId: string): Promise<RtcRegistry> {
  return runInDurableObject(roomStub(serverId), async (_i, state) => {
    return new RoomState(state, env).rtcSnapshot();
  });
}

function screenCount(reg: RtcRegistry): number {
  return Object.values(reg.tracks).filter((t) => t.kind === "screen").length;
}

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

async function meUserId(token: string): Promise<string> {
  const body: { user: { userId: string } } = await (await authed(token, "/api/me")).json();
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
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const summary: { id: string } = await res.json();
  return summary.id;
}

// Seed voice membership straight into DO KV (the default project cannot drive DO WebSockets; the
// rtcAuthorize path re-reads `voice` from KV — mirrors rtc-proxy.test.ts).
async function seedVoice(serverId: string, userIds: string[]): Promise<void> {
  await runInDurableObject(roomStub(serverId), async (_i, state) => {
    await state.storage.put("voice", {
      members: userIds.map((userId) => ({ userId, muted: false, deafened: false })),
      sessionStartedAt: Date.now(),
    });
  });
}

function seedShares(serverId: string, count: number): Promise<Response> {
  return SELF.fetch(`${BASE}/api/__test/seed-shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverId, count }),
  });
}

describe("S8.5 test-seed route", () => {
  it("404s when TAVERN_SFU_MOCK is absent (production guard)", async () => {
    const ctx = createExecutionContext();
    const req = new Request(`${BASE}/api/__test/seed-shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId: "any", count: 4 }),
    });
    // Invoke the app directly with the mock flag stripped — the pool-workers env sets it, so this is
    // the only way to observe the guard's production behavior.
    const res = await app.fetch(req, { ...env, TAVERN_SFU_MOCK: undefined }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("seeds N synthetic screen shares into the DO registry when the flag is set", async () => {
    const serverId = `seed-${crypto.randomUUID()}`;
    const res = await seedShares(serverId, 4);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ screens: 4 });
    expect(screenCount(await readRegistry(serverId))).toBe(4);
  });

  it("rejects a malformed body with bad_request", async () => {
    const res = await SELF.fetch(`${BASE}/api/__test/seed-shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId: "s" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("G4: seeding 4 shares makes an in-voice member's 5th screen publish → share_cap", async () => {
    resetSfuMock();
    const token = await register("seed_cap_owner");
    const userId = await meUserId(token);
    const serverId = await createServer(token, "seed-cap-server");
    await seedVoice(serverId, [userId]);

    // Establish a real SFU session for the publisher (mock SFU), then seed the cap full.
    const sessionRes = await authed(token, `/api/rtc/${serverId}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(sessionRes.status).toBe(200);
    const { sessionId }: { sessionId: string } = await sessionRes.json();

    expect(await (await seedShares(serverId, 4)).json()).toEqual({ screens: 4 });

    // The publisher's own 5th concurrent screen is rejected by the DO before the SFU is called.
    const publishRes = await authed(token, `/api/rtc/${serverId}/tracks?session=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionDescription: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n" },
        tracks: [{ location: "local", mid: "0", trackName: `screen:${userId}:1` }],
      }),
    });
    expect(publishRes.status).toBe(403);
    expect(await publishRes.json()).toEqual({ error: "share_cap" });
  });
});

// POST /api/__test/seed-code with TAVERN_TEST=1 forced on. The default pool-workers env sets only
// TAVERN_SFU_MOCK, so drive the app directly with the flag added — same shape as the seed-shares
// production-guard test above. Returns the freshly minted one-time code.
async function seedCodeViaRoute(): Promise<string> {
  const ctx = createExecutionContext();
  const req = new Request(`${BASE}/api/__test/seed-code`, { method: "POST" });
  const res = await app.fetch(req, { ...env, TAVERN_TEST: "1" }, ctx);
  await waitOnExecutionContext(ctx);
  if (res.status !== 200) throw new Error(`seed-code failed: ${res.status} ${await res.text()}`);
  const body: { code: string } = await res.json();
  return body.code;
}

describe("FR-08 seed-code route", () => {
  it("with TAVERN_TEST=1 returns a code whose D1 row exists unused", async () => {
    const code = await seedCodeViaRoute();
    const row = must(
      await env.DB.prepare(
        "SELECT used_by_user_id, used_at, created_server_id FROM server_creation_codes WHERE code = ?",
      )
        .bind(code)
        .first<{
          used_by_user_id: string | null;
          used_at: number | null;
          created_server_id: string | null;
        }>(),
      "seeded code row",
    );
    expect(row.used_by_user_id).toBeNull();
    expect(row.used_at).toBeNull();
    expect(row.created_server_id).toBeNull();
  });

  it("a seeded code creates a server via POST /api/servers", async () => {
    const token = await register("seed_code_creator");
    const code = await seedCodeViaRoute();
    const res = await authed(token, "/api/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "seed-code-srv", password: "hunter2", code }),
    });
    expect(res.status).toBe(201);
  });

  it("404s when TAVERN_TEST is not '1' (route guard)", async () => {
    // The pool-workers env opens the /api/__test mount (TAVERN_SFU_MOCK=1) but does NOT set
    // TAVERN_TEST, so the route's own guard is the only thing left — mirrors the set-egress guard.
    const res = await SELF.fetch(`${BASE}/api/__test/seed-code`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
