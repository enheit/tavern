import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, MeResponse, ServerSummary } from "@tavern/shared";
import { hashServerPassword, verifyServerPassword } from "../src/lib/passwords";

const BASE = "https://tavern.test";

// Invariant helper (no non-null `!` per §9.1): narrows a nullable to its value or fails the test.
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// Register a fresh account (register replies with set-auth-token, so no rate-limited sign-in is
// needed) and return its bearer token.
async function session(username: string): Promise<string> {
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

function createServer(token: string, body: unknown): Promise<Response> {
  return authed(token, "/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function joinServer(token: string, body: unknown): Promise<Response> {
  return authed(token, "/api/servers/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchProfile(token: string, body: unknown): Promise<Response> {
  return authed(token, "/api/me/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function meUserId(token: string): Promise<string> {
  const body = MeResponse.parse(await (await authed(token, "/api/me")).json());
  return body.user.userId;
}

async function createdSummary(token: string, body: unknown): Promise<ServerSummary> {
  const res = await createServer(token, body);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return ServerSummary.parse(await res.json());
}

// Insert a bare `user` row directly (no auth round-trip). REQUIRED because the miniflare test D1
// ENFORCES the servers/memberships REFERENCES user(id) foreign keys, so cap/fullness seeds need
// real user rows. email is UNIQUE; username stays NULL (SQLite allows many NULLs under UNIQUE).
async function seedUser(): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO user (id, name, email, display_name) VALUES (?, ?, ?, ?)")
    .bind(id, id, `${id}@users.tavern.invalid`, id)
    .run();
  return id;
}

// Insert a server row directly (bypasses the API) with a freshly seeded admin — used to seed the
// membership caps cheaply.
async function seedServer(nickname: string): Promise<string> {
  const admin = await seedUser();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO servers (id, nickname, password_hash, admin_user_id, created_at) VALUES (?, ?, NULL, ?, ?)",
  )
    .bind(id, nickname, admin, Date.now())
    .run();
  return id;
}

async function seedMembership(userId: string, serverId: string): Promise<void> {
  await env.DB.prepare("INSERT INTO memberships (user_id, server_id, joined_at) VALUES (?, ?, ?)")
    .bind(userId, serverId, Date.now())
    .run();
}

describe("FR-08 create server", () => {
  it("creates server, caller is admin, membership exists, 201 ServerSummary", async () => {
    const token = await session("crua");
    const userId = await meUserId(token);
    const res = await createServer(token, { nickname: "mytavern" });
    expect(res.status).toBe(201);
    const summary = ServerSummary.parse(await res.json());
    expect(summary).toMatchObject({
      nickname: "mytavern",
      adminUserId: userId,
      hasPassword: false,
    });

    const server = must(
      await env.DB.prepare("SELECT admin_user_id FROM servers WHERE id = ?")
        .bind(summary.id)
        .first<{ admin_user_id: string }>(),
      "server row",
    );
    expect(server.admin_user_id).toBe(userId);
    const membership = await env.DB.prepare(
      "SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?",
    )
      .bind(userId, summary.id)
      .first();
    expect(membership).not.toBeNull();
  });

  it("seeds exactly one voice + one text channel (FR-13)", async () => {
    const token = await session("chua");
    const summary = await createdSummary(token, { nickname: "chanserver" });
    const channels = await env.DB.prepare(
      "SELECT kind, name FROM channels WHERE server_id = ? ORDER BY kind",
    )
      .bind(summary.id)
      .all<{ kind: string; name: string }>();
    expect(channels.results).toEqual([
      { kind: "text", name: "General" },
      { kind: "voice", name: "Voice" },
    ]);
  });

  it("duplicate nickname case-insensitive → 409 nickname_taken", async () => {
    const a = await session("dupa");
    await createdSummary(a, { nickname: "DupServer" });
    const b = await session("dupb");
    const res = await createServer(b, { nickname: "dupserver" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "nickname_taken" });
  });

  it("nickname failing App-B regex → 400 bad_request", async () => {
    const token = await session("regexa");
    const short = await createServer(token, { nickname: "no" });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "bad_request" });
    const spaced = await createServer(token, { nickname: "bad name" });
    expect(spaced.status).toBe(400);
    expect(await spaced.json()).toEqual({ error: "bad_request" });
  });

  it("password stored as pbkdf2$100000$… (never plaintext), hasPassword=true in response", async () => {
    const token = await session("pwstore");
    const summary = await createdSummary(token, { nickname: "secretserver", password: "hunter2" });
    expect(summary.hasPassword).toBe(true);
    const row = must(
      await env.DB.prepare("SELECT password_hash FROM servers WHERE id = ?")
        .bind(summary.id)
        .first<{ password_hash: string }>(),
      "server row",
    );
    expect(row.password_hash).toMatch(/^pbkdf2\$100000\$/);
    expect(row.password_hash).not.toContain("hunter2");
    expect(await verifyServerPassword("hunter2", row.password_hash)).toBe(true);
  });
});

describe("FR-09 join server", () => {
  it("join open server by nickname (case-insensitive) succeeds", async () => {
    const admin = await session("openadmin");
    const created = await createdSummary(admin, { nickname: "OpenServer" });
    const joiner = await session("openjoiner");
    const res = await joinServer(joiner, { nickname: "openserver" });
    expect(res.status).toBe(200);
    const summary = ServerSummary.parse(await res.json());
    expect(summary.id).toBe(created.id);
  });

  it("join password server: wrong → 403 wrong_password; right → 200", async () => {
    const admin = await session("pwadmin");
    await createdSummary(admin, { nickname: "pwserver", password: "secret" });
    const joiner = await session("pwjoiner");

    const missing = await joinServer(joiner, { nickname: "pwserver" });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "wrong_password" });

    const wrong = await joinServer(joiner, { nickname: "pwserver", password: "nope" });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "wrong_password" });

    const right = await joinServer(joiner, { nickname: "pwserver", password: "secret" });
    expect(right.status).toBe(200);
    expect(ServerSummary.parse(await right.json()).hasPassword).toBe(true);
  });

  it("re-join is idempotent → 200 same summary, single membership row", async () => {
    const token = await session("idem");
    const userId = await meUserId(token);
    const created = await createdSummary(token, { nickname: "idemserver" });
    const rejoin = await joinServer(token, { nickname: "idemserver" });
    expect(rejoin.status).toBe(200);
    const summary = ServerSummary.parse(await rejoin.json());
    expect(summary.id).toBe(created.id);
    expect(summary.joinedAt).toBe(created.joinedAt);
    const count = must(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND server_id = ?",
      )
        .bind(userId, created.id)
        .first<{ n: number }>(),
      "count row",
    );
    expect(count.n).toBe(1);
  });

  it("unknown nickname → 404 not_found", async () => {
    const token = await session("unkjoin");
    const res = await joinServer(token, { nickname: "ghost-server" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("21st server → 403 server_cap", async () => {
    const token = await session("capuser");
    const userId = await meUserId(token);
    // Seed the user to the per-user cap (maxServersPerUser memberships).
    const indices = Array.from({ length: LIMITS.maxServersPerUser }, (_, i) => i);
    await Promise.all(
      indices.map(async (i) => {
        const sid = await seedServer(`capseed-${i}`);
        await seedMembership(userId, sid);
      }),
    );
    await seedServer("cap-target");
    const res = await joinServer(token, { nickname: "cap-target" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "server_cap" });
  });

  it("join when server already has LIMITS.maxMembersPerServer members → 403 server_full", async () => {
    const admin = await session("fulladmin");
    const created = await createdSummary(admin, { nickname: "fullserver" });
    // Admin is member #1; seed the rest up to the cap with real (FK-satisfying) dummy members.
    const dummies = await Promise.all(
      Array.from({ length: LIMITS.maxMembersPerServer - 1 }, () => seedUser()),
    );
    await Promise.all(dummies.map((uid) => seedMembership(uid, created.id)));

    const outsider = await session("fulloutsider");
    const full = await joinServer(outsider, { nickname: "fullserver" });
    expect(full.status).toBe(403);
    expect(await full.json()).toEqual({ error: "server_full" });

    // An existing member re-joining a full server still gets 200 (checked before the fullness guard).
    const rejoin = await joinServer(admin, { nickname: "fullserver" });
    expect(rejoin.status).toBe(200);
  });
});

describe("FR-13 channels schema", () => {
  it("kind CHECK constraint rejects other values", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO channels (id, server_id, kind, name, created_at) VALUES (?, ?, 'bogus', 'X', ?)",
      )
        .bind(crypto.randomUUID(), crypto.randomUUID(), Date.now())
        .run(),
    ).rejects.toThrow();
  });
});

describe("FR-41 persistence", () => {
  it("created server + membership persist as D1 rows", async () => {
    const token = await session("persa");
    const userId = await meUserId(token);
    const summary = await createdSummary(token, { nickname: "persserver" });
    const server = await env.DB.prepare(
      "SELECT id, nickname, admin_user_id FROM servers WHERE id = ?",
    )
      .bind(summary.id)
      .first();
    expect(server).toMatchObject({ id: summary.id, nickname: "persserver", admin_user_id: userId });
    const membership = await env.DB.prepare(
      "SELECT joined_at FROM memberships WHERE user_id = ? AND server_id = ?",
    )
      .bind(userId, summary.id)
      .first();
    expect(membership).not.toBeNull();
  });
});

describe("FR-43 boot integration", () => {
  it("/api/me lists joined servers with hasPassword flag and no password_hash", async () => {
    const token = await session("boot43");
    await createdSummary(token, { nickname: "bootserver", password: "boots" });
    const me = MeResponse.parse(await (await authed(token, "/api/me")).json());
    expect(me.servers).toHaveLength(1);
    expect(me.servers[0]?.hasPassword).toBe(true);
    const serialized = JSON.stringify(me.servers);
    expect(serialized).not.toContain("password_hash");
    expect(serialized).not.toContain("pbkdf2");
  });
});

describe("membership guard", () => {
  it("GET /api/servers/:id/members → 403 not_member for outsider, 200 profiles for member", async () => {
    const admin = await session("guarda");
    const adminId = await meUserId(admin);
    const created = await createdSummary(admin, { nickname: "guardserver" });

    const outsider = await session("guardb");
    const denied = await authed(outsider, `/api/servers/${created.id}/members`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "not_member" });

    const ok = await authed(admin, `/api/servers/${created.id}/members`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      members: [expect.objectContaining({ userId: adminId, username: "guarda" })],
    });
  });

  it("unknown server id → 404 not_found", async () => {
    const token = await session("guardc");
    const res = await authed(token, `/api/servers/${crypto.randomUUID()}/members`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("unauthenticated → 401 unauthorized", async () => {
    const res = await SELF.fetch(`${BASE}/api/servers/${crypto.randomUUID()}/members`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("media membership gate (sounds/recordings)", () => {
  it("member reaches sounds/{serverId}/… (404 when object absent, not 403)", async () => {
    const token = await session("meddm");
    const created = await createdSummary(token, { nickname: "medserver" });
    const res = await authed(token, `/api/media/sounds/${created.id}/none.mp3`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("non-member → 403 not_member for recordings/{serverId}/…", async () => {
    const admin = await session("medadmin");
    const created = await createdSummary(admin, { nickname: "medrec" });
    const outsider = await session("medout");
    const res = await authed(outsider, `/api/media/recordings/${created.id}/r.webm`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });
  });

  it("unknown media prefix → 403 not_member", async () => {
    const token = await session("medunk");
    const res = await authed(token, "/api/media/other/whatever.bin");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });
  });
});

describe("FR-03 fan-out wiring", () => {
  it("PATCH profile calls the DO once per joined server (spy on DO stub fetch)", async () => {
    const token = await session("fanout");
    const userId = await meUserId(token);
    const created = await createdSummary(token, { nickname: "fanoutone" });
    // Second membership seeded directly (join would itself call idFromName, polluting the spy).
    const secondId = await seedServer("fanouttwo");
    await seedMembership(userId, secondId);

    const spy = vi.spyOn(env.SERVER_ROOM, "idFromName");
    const patched = await patchProfile(token, { displayName: "Faned Out" });
    expect(patched.status).toBe(200);

    // Fan-out runs in ctx.waitUntil (background) — poll until both joined-server DOs are addressed.
    await vi.waitFor(
      () => {
        expect(spy).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000, interval: 50 },
    );
    expect(spy).toHaveBeenCalledWith(created.id);
    expect(spy).toHaveBeenCalledWith(secondId);
    spy.mockRestore();
  });
});

describe("server password hashing (unit)", () => {
  it("round-trips a correct password and rejects a wrong one", async () => {
    const stored = await hashServerPassword("correct horse");
    expect(stored).toMatch(/^pbkdf2\$100000\$/);
    expect(await verifyServerPassword("correct horse", stored)).toBe(true);
    expect(await verifyServerPassword("battery staple", stored)).toBe(false);
  });

  it("returns false for a structurally invalid stored value", async () => {
    expect(await verifyServerPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyServerPassword("x", "pbkdf2$0$c2FsdA==$aGFzaA==")).toBe(false);
    expect(await verifyServerPassword("x", "scrypt$100000$c2FsdA==$aGFzaA==")).toBe(false);
  });
});
