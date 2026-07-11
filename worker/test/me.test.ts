import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS, MeResponse, USER_COLORS } from "@tavern/shared";
import { notifyJoinedServers } from "../src/lib/fanout";

const BASE = "https://tavern.test";

// Invariant helper (no non-null `!` per §9.1): narrows a nullable to its value or fails the test.
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// Distinct client IP per sign-in → distinct `/sign-in/username` rate-limit bucket (max 3/10s per
// ip|path). Registration (the /api/auth-wrap wrapper) is NOT rate-limited.
function ip(addr: string): Record<string, string> {
  return { "x-forwarded-for": addr };
}

function register(username: string, password = "password123"): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, repeatPassword: password }),
  });
}

function login(username: string, password: string, addr: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ip(addr) },
    body: JSON.stringify({ username, password }),
  });
}

// Register a fresh account and return its bearer token (register replies with set-auth-token, so no
// separate rate-limited sign-in is needed for the authenticated-route tests).
async function session(username: string): Promise<string> {
  const res = await register(username);
  if (!res.ok) throw new Error(`register ${username} failed: ${res.status} ${await res.text()}`);
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

// Minimal RIFF....WEBP container: bytes 0–3 "RIFF", bytes 8–11 "WEBP" (bytes 4–7 = size, unchecked).
function webpBytes(size = 16): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  return bytes;
}

// PNG signature 89 50 4E 47 0D 0A 1A 0A — never matches the RIFF/WEBP magic.
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
}

function uploadAvatar(
  token: string,
  bytes: Uint8Array,
  contentType = "image/webp",
): Promise<Response> {
  return authed(token, "/api/me/avatar", {
    method: "POST",
    headers: { "content-type": contentType },
    body: bytes,
  });
}

function patchProfile(token: string, body: unknown): Promise<Response> {
  return authed(token, "/api/me/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Insert a bare `user` row directly (no auth round-trip) — the fan-out seam test needs a real
// user for the enforced memberships FK (miniflare D1 enforces REFERENCES). email is UNIQUE.
async function seedUser(): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO user (id, name, email, display_name) VALUES (?, ?, ?, ?)")
    .bind(id, id, `${id}@users.tavern.invalid`, id)
    .run();
  return id;
}

describe("FR-43 boot call /api/me", () => {
  it("returns user + default settings + empty servers for a fresh account", async () => {
    const token = await session("boota");
    const res = await authed(token, "/api/me");
    expect(res.status).toBe(200);
    const body = MeResponse.parse(await res.json());
    expect(body).toMatchObject({
      user: { username: "boota", displayName: "boota" },
      settings: { notifyAll: true, notifyMentions: true, locale: "en", theme: "system" },
      servers: [],
    });
    // A fresh account gets a random NON-gray palette color (no fixed gray default anymore).
    expect(USER_COLORS).toContain(body.user.color);
  });

  it("response parses with shared MeResponse schema (shape lock)", async () => {
    const token = await session("bootb");
    const res = await authed(token, "/api/me");
    const parsed = MeResponse.safeParse(await res.json());
    expect(parsed.success).toBe(true);
  });

  it("contains no email key anywhere (deep scan)", async () => {
    const token = await session("bootc");
    const serialized = JSON.stringify(await (await authed(token, "/api/me")).json());
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("@users.tavern.invalid");
  });

  it("unauthenticated → 401 unauthorized", async () => {
    const res = await SELF.fetch(`${BASE}/api/me`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("FR-03 display name & username", () => {
  it("updates displayName within 1..32", async () => {
    const token = await session("dna");
    const res = await patchProfile(token, { displayName: "Ada Lovelace" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayName: "Ada Lovelace", username: "dna" });
    const me = MeResponse.parse(await (await authed(token, "/api/me")).json());
    expect(me.user.displayName).toBe("Ada Lovelace");
  });

  it("rejects displayName of 0 and 33 chars → bad_request", async () => {
    const token = await session("dnb");
    const empty = await patchProfile(token, { displayName: "" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "bad_request" });
    const tooLong = await patchProfile(token, { displayName: "x".repeat(33) });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "bad_request" });
  });

  it("rejects an empty patch object → bad_request", async () => {
    const token = await session("dnc");
    const res = await patchProfile(token, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("username change updates login: old username fails, new one signs in", async () => {
    const token = await session("olduser");
    const patched = await patchProfile(token, { username: "newuser" });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ username: "newuser" });

    const old = await login("olduser", "password123", "198.51.100.1");
    expect(old.status).toBe(401);
    const fresh = await login("newuser", "password123", "198.51.100.2");
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("set-auth-token")).toBeTruthy();
  });

  it("username change to an existing name → 409 username_taken", async () => {
    const token = await session("takena");
    await register("takenb");
    const res = await patchProfile(token, { username: "takenb" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "username_taken" });
  });
});

describe("FR-04 color", () => {
  it("accepts #a1b2c3", async () => {
    const token = await session("cola");
    const res = await patchProfile(token, { color: "#a1b2c3" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ color: "#a1b2c3" });
    const me = MeResponse.parse(await (await authed(token, "/api/me")).json());
    expect(me.user.color).toBe("#a1b2c3");
  });

  it("rejects #zzz, red, #A1B2C3G → bad_request", async () => {
    const token = await session("colb");
    const results = await Promise.all(
      ["#zzz", "red", "#A1B2C3G"].map(async (color) => {
        const res = await patchProfile(token, { color });
        return { status: res.status, body: await res.json() };
      }),
    );
    for (const { status, body } of results) {
      expect(status).toBe(400);
      expect(body).toEqual({ error: "bad_request" });
    }
  });
});

describe("FR-05 avatar", () => {
  it("valid webp bytes → 200, avatarKey set, R2 object exists with contentType image/webp", async () => {
    const token = await session("avata");
    const userId = await meUserId(token);
    const res = await uploadAvatar(token, webpBytes());
    expect(res.status).toBe(200);
    const expectedKey = `avatars/${userId}.webp`;
    expect(await res.json()).toEqual({ avatarKey: expectedKey });

    const me = MeResponse.parse(await (await authed(token, "/api/me")).json());
    expect(me.user.avatarKey).toBe(expectedKey);

    const object = must(await env.MEDIA.get(expectedKey), "R2 avatar object missing");
    expect(object.httpMetadata?.contentType).toBe("image/webp");
  });

  it("png magic bytes → 415 unsupported_media", async () => {
    const token = await session("avatb");
    const res = await uploadAvatar(token, pngBytes());
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "unsupported_media" });
  });

  it("wrong content-type → 415 unsupported_media", async () => {
    const token = await session("avatc");
    const res = await uploadAvatar(token, webpBytes(), "image/png");
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "unsupported_media" });
  });

  it("content-length over LIMITS.avatarMaxBytes → 413 payload_too_large", async () => {
    const token = await session("avatd");
    const res = await uploadAvatar(token, webpBytes(LIMITS.avatarMaxBytes + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("GET /api/media/avatars/{id}.webp streams bytes with ETag + Cache-Control", async () => {
    const token = await session("avate");
    const userId = await meUserId(token);
    await uploadAvatar(token, webpBytes());

    const res = await authed(token, `/api/media/avatars/${userId}.webp`);
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    // Avatars use a stable per-user URL overwritten on re-upload, so they revalidate (no-cache)
    // rather than pin a long max-age — otherwise a fresh upload would keep serving the old image.
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(16);
    expect(Array.from(body.slice(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);

    // A matching If-None-Match short-circuits to 304 (cheap revalidation for the stable URL).
    const notModified = await authed(token, `/api/media/avatars/${userId}.webp`, {
      headers: { "if-none-match": must(etag, "etag present") },
    });
    expect(notModified.status).toBe(304);
  });

  it("missing avatar key → 404 not_found", async () => {
    const token = await session("avatf");
    const res = await authed(token, "/api/media/avatars/does-not-exist.webp");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("non-avatars prefix → 403 not_member (membership check lands in S2.1)", async () => {
    const token = await session("avatg");
    const res = await authed(token, "/api/media/sounds/s1/x.mp3");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });
  });
});

describe("FR-06/FR-07 settings", () => {
  it("GET before any PUT returns defaults (notifyAll on, mentions on, en, system) without creating a row", async () => {
    const token = await session("seta");
    const userId = await meUserId(token);
    const res = await authed(token, "/api/me/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      notifyAll: true,
      notifyMentions: true,
      locale: "en",
      theme: "system",
    });
    // Defaults must NOT be persisted — no row exists until the first PUT.
    const row = await env.DB.prepare("SELECT user_id FROM user_settings WHERE user_id = ?")
      .bind(userId)
      .first();
    expect(row).toBeNull();
  });

  it("PUT then GET round-trips all four fields", async () => {
    const token = await session("setb");
    const desired = { notifyAll: false, notifyMentions: false, locale: "uk", theme: "dark" };
    const put = await authed(token, "/api/me/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(desired),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(desired);
    const got = await authed(token, "/api/me/settings");
    expect(await got.json()).toEqual(desired);
  });

  it("PUT is an upsert — a second PUT overwrites the first", async () => {
    const token = await session("setc");
    const write = (theme: string): Promise<Response> =>
      authed(token, "/api/me/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notifyAll: true, notifyMentions: true, locale: "en", theme }),
      });
    await write("dark");
    await write("light");
    const got = await authed(token, "/api/me/settings");
    expect(await got.json()).toMatchObject({ theme: "light" });
  });

  it("PUT with partial body → 400 bad_request", async () => {
    const token = await session("setd");
    const res = await authed(token, "/api/me/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notifyAll: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});

describe("FR-03 fan-out seam (notifyJoinedServers)", () => {
  // The `memberships` table now lands via migration 0002 (S2.1) WITH enforced FK references to
  // user(id)/servers(id) — the miniflare test D1 enforces them — so a joined-server row must seed a
  // real user + real server. The placeholder ServerRoom answers 501 (its /internal handler lands in
  // S3.1); the helper fires the POST and does not gate on the response, so it resolves.
  const profile = {
    userId: crypto.randomUUID(),
    username: "zoe",
    displayName: "Zoe",
    color: "#a1b2c3",
  };

  it("POSTs member.update to each joined server's DO stub", async () => {
    const userId = await seedUser();
    const serverId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO servers (id, nickname, password_hash, admin_user_id, created_at) VALUES (?, ?, NULL, ?, ?)",
    )
      .bind(serverId, `seam-${serverId.slice(0, 8)}`, userId, Date.now())
      .run();
    await env.DB.prepare("INSERT INTO memberships (user_id, server_id, joined_at) VALUES (?, ?, ?)")
      .bind(userId, serverId, Date.now())
      .run();
    await expect(
      notifyJoinedServers(env, userId, { t: "member.update", profile }),
    ).resolves.toBeUndefined();
  });

  it("no joined servers → resolves without fetching", async () => {
    await expect(
      notifyJoinedServers(env, "nobody", { t: "member.update", profile }),
    ).resolves.toBeUndefined();
  });
});
