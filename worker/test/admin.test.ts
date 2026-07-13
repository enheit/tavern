import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MeResponse, PointConfig, ServerSummary } from "@tavern/shared";

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

// Seed a fresh one-time server-creation code into D1 (migration 0003) and return it — the create
// route burns one atomically per server.
async function seedCode(): Promise<string> {
  const code = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO server_creation_codes (code, created_at) VALUES (?, ?)")
    .bind(code, Date.now())
    .run();
  return code;
}

// POST /api/servers. Password is now required and creation is gated by a one-time code, so auto-seed
// a fresh code and default the password; both are overridable via `body` (later keys win).
async function createdSummary(
  token: string,
  body: Record<string, unknown>,
): Promise<ServerSummary> {
  const code = await seedCode();
  const res = await authed(token, "/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "hunter2", code, ...body }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return ServerSummary.parse(await res.json());
}

function joinServer(token: string, body: unknown): Promise<Response> {
  return authed(token, "/api/servers/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchServer(token: string, serverId: string, body: unknown): Promise<Response> {
  return authed(token, `/api/servers/${serverId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putPointConfig(token: string, serverId: string, body: unknown): Promise<Response> {
  return authed(token, `/api/servers/${serverId}/points/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function kick(token: string, serverId: string, userId: string): Promise<Response> {
  return authed(token, `/api/servers/${serverId}/members/${userId}`, { method: "DELETE" });
}

async function me(token: string): Promise<MeResponse> {
  return MeResponse.parse(await (await authed(token, "/api/me")).json());
}

async function meUserId(token: string): Promise<string> {
  return (await me(token)).user.userId;
}

function serverIn(profile: MeResponse, serverId: string): ServerSummary | undefined {
  return profile.servers.find((s) => s.id === serverId);
}

describe("FR-12 rename", () => {
  it("admin renames; GET /api/me shows new nickname; server id unchanged", async () => {
    const admin = await session("renadmin");
    const created = await createdSummary(admin, { nickname: "oldname" });

    const res = await patchServer(admin, created.id, { nickname: "newname" });
    expect(res.status).toBe(200);
    const summary = ServerSummary.parse(await res.json());
    expect(summary.id).toBe(created.id); // id is stable (FR-12)
    expect(summary.nickname).toBe("newname");

    const listed = must(serverIn(await me(admin), created.id), "server still listed for admin");
    expect(listed.nickname).toBe("newname");
    expect(listed.id).toBe(created.id);
  });

  it("rename to another server's nickname (case-insensitive) → 409 nickname_taken", async () => {
    const one = await session("clashone");
    await createdSummary(one, { nickname: "takenname" });
    const two = await session("clashtwo");
    const mine = await createdSummary(two, { nickname: "myname" });

    const res = await patchServer(two, mine.id, { nickname: "TAKENNAME" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "nickname_taken" });

    // Renaming to its OWN current nickname (differing only in case) is NOT a clash with self.
    const self = await patchServer(two, mine.id, { nickname: "MYNAME" });
    expect(self.status).toBe(200);
    expect(ServerSummary.parse(await self.json()).nickname).toBe("MYNAME");
  });

  it("non-admin member → 403 not_admin; outsider → 403 not_member", async () => {
    const admin = await session("adm12");
    const created = await createdSummary(admin, { nickname: "guardserver12" });

    const member = await session("mem12");
    expect(
      (await joinServer(member, { nickname: "guardserver12", password: "hunter2" })).status,
    ).toBe(200);
    const asMember = await patchServer(member, created.id, { nickname: "hijack" });
    expect(asMember.status).toBe(403);
    expect(await asMember.json()).toEqual({ error: "not_admin" });

    const outsider = await session("out12");
    const asOutsider = await patchServer(outsider, created.id, { nickname: "hijack" });
    expect(asOutsider.status).toBe(403);
    expect(await asOutsider.json()).toEqual({ error: "not_member" });
  });

  it("empty patch body → 400 bad_request", async () => {
    const admin = await session("empty12");
    const created = await createdSummary(admin, { nickname: "emptyserver12" });
    const res = await patchServer(admin, created.id, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});

describe("server point configuration", () => {
  const config = {
    enabled: true,
    basePointsPerMinute: 7,
    streamerBonusPerMinute: 9,
    watcherBonusPerMinute: 11,
    dailyCap: 500,
  };

  it("lets the server admin update rates without a deployment", async () => {
    const admin = await session("pointadmin");
    const created = await createdSummary(admin, { nickname: "pointserver" });

    const response = await putPointConfig(admin, created.id, config);

    expect(response.status).toBe(200);
    expect(PointConfig.parse(await response.json())).toEqual(config);
  });

  it("rejects a regular member and invalid rate values", async () => {
    const admin = await session("pointguardadmin");
    const created = await createdSummary(admin, { nickname: "pointguardserver" });
    const member = await session("pointguardmember");
    expect(
      (await joinServer(member, { nickname: "pointguardserver", password: "hunter2" })).status,
    ).toBe(200);

    const forbidden = await putPointConfig(member, created.id, config);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "not_admin" });

    const invalid = await putPointConfig(admin, created.id, {
      ...config,
      basePointsPerMinute: -1,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "bad_request" });
  });
});

describe("FR-10 password change", () => {
  it("set password: next join requires the NEW password (wrong → 403 wrong_password)", async () => {
    const admin = await session("pwsetadmin");
    const created = await createdSummary(admin, { nickname: "pwsetserver" });
    expect(created.hasPassword).toBe(true); // always set now; PATCH replaces it below

    const patched = await patchServer(admin, created.id, { password: "s3cret" });
    expect(patched.status).toBe(200);
    expect(ServerSummary.parse(await patched.json()).hasPassword).toBe(true);

    const joiner = await session("pwsetjoiner");
    const none = await joinServer(joiner, { nickname: "pwsetserver" });
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({ error: "wrong_password" });

    const wrong = await joinServer(joiner, { nickname: "pwsetserver", password: "nope" });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "wrong_password" });

    const right = await joinServer(joiner, { nickname: "pwsetserver", password: "s3cret" });
    expect(right.status).toBe(200);
    expect(ServerSummary.parse(await right.json()).id).toBe(created.id);
  });

  it("clearing the password is not possible: PATCH {password: null} → 400 bad_request", async () => {
    const admin = await session("pwclradmin");
    const created = await createdSummary(admin, { nickname: "pwclrserver", password: "openme" });
    expect(created.hasPassword).toBe(true);

    // A server password is always set (no open servers), so the schema rejects null outright.
    const patched = await patchServer(admin, created.id, { password: null });
    expect(patched.status).toBe(400);
    expect(await patched.json()).toEqual({ error: "bad_request" });

    // The password is untouched — the server still requires one to join.
    const listed = must(serverIn(await me(admin), created.id), "server still listed");
    expect(listed.hasPassword).toBe(true);
    const joiner = await session("pwclrjoiner");
    const none = await joinServer(joiner, { nickname: "pwclrserver" });
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({ error: "wrong_password" });
  });

  it("existing member unaffected (their /api/me still lists the server)", async () => {
    const admin = await session("pwmemadmin");
    const created = await createdSummary(admin, { nickname: "pwmemserver" });
    const member = await session("pwmember");
    expect(
      (await joinServer(member, { nickname: "pwmemserver", password: "hunter2" })).status,
    ).toBe(200);

    // Admin changes the password AFTER the member already joined.
    expect((await patchServer(admin, created.id, { password: "afterjoin" })).status).toBe(200);

    // The existing member's membership is untouched — /api/me still lists the server.
    const listed = must(serverIn(await me(member), created.id), "member still lists the server");
    expect(listed.id).toBe(created.id);
    expect(listed.hasPassword).toBe(true);
  });
});

describe("FR-11 kick — catalog side", () => {
  it("membership row deleted; kicked user's /api/me no longer lists the server", async () => {
    const admin = await session("kickadmin");
    const created = await createdSummary(admin, { nickname: "kickserver" });
    const member = await session("kickmember");
    const memberId = await meUserId(member);
    expect((await joinServer(member, { nickname: "kickserver", password: "hunter2" })).status).toBe(
      200,
    );
    expect(serverIn(await me(member), created.id)).toBeDefined();

    const res = await kick(admin, created.id, memberId);
    expect(res.status).toBe(204);

    const row = await env.DB.prepare(
      "SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?",
    )
      .bind(memberId, created.id)
      .first();
    expect(row).toBeNull();
    expect(serverIn(await me(member), created.id)).toBeUndefined();
  });

  it("rejoin after kick requires the current password", async () => {
    const admin = await session("rjadmin");
    const created = await createdSummary(admin, { nickname: "rjserver", password: "keepout" });
    const member = await session("rjmember");
    const memberId = await meUserId(member);
    expect((await joinServer(member, { nickname: "rjserver", password: "keepout" })).status).toBe(
      200,
    );

    expect((await kick(admin, created.id, memberId)).status).toBe(204);

    // Rejoin without / with the wrong password is rejected; the current password lets them back in.
    const none = await joinServer(member, { nickname: "rjserver" });
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({ error: "wrong_password" });

    const right = await joinServer(member, { nickname: "rjserver", password: "keepout" });
    expect(right.status).toBe(200);
    expect(ServerSummary.parse(await right.json()).id).toBe(created.id);
  });

  it("kick self → 400 bad_request; kick non-member → 404 not_found", async () => {
    const admin = await session("selfadmin");
    const adminId = await meUserId(admin);
    const created = await createdSummary(admin, { nickname: "selfserver" });

    const selfRes = await kick(admin, created.id, adminId);
    expect(selfRes.status).toBe(400);
    expect(await selfRes.json()).toEqual({ error: "bad_request" });

    // A real account that never joined this server → 404 not_found (distinct from the self case).
    const stranger = await session("stranger");
    const strangerId = await meUserId(stranger);
    const nonMember = await kick(admin, created.id, strangerId);
    expect(nonMember.status).toBe(404);
    expect(await nonMember.json()).toEqual({ error: "not_found" });
  });
});
