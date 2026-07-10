import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, withAuth, zodJson } from "../src/middleware";
import type { AuthVars } from "../src/middleware";

const BASE = "https://tavern.test";

// Invariant helper (no non-null `!` per §9.1): narrows a nullable to its value or fails the test.
function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// Distinct client IP per login → distinct `/sign-in/username` rate-limit bucket (max 3/10s per
// ip|path). better-auth's default IP header is x-forwarded-for; a single valid IP is trusted.
function ip(addr: string): Record<string, string> {
  return { "x-forwarded-for": addr };
}

function register(
  username: string,
  password: string,
  repeatPassword = password,
): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, repeatPassword }),
  });
}

function login(username: string, password: string, addr: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ip(addr) },
    body: JSON.stringify({ username, password }),
  });
}

// A tiny app that mounts the REAL withAuth + requireAuth (+ zodJson) middleware, driven with the
// pool-workers `env` as bindings — exercises the guards without a product route existing yet.
const probe = new Hono<{ Bindings: Env; Variables: AuthVars }>();
probe.use("*", withAuth);
probe.get("/probe", requireAuth, (c) => c.json({ userId: c.var.userId }));
probe.post("/validated", zodJson(z.object({ x: z.number() })), (c) => c.json({ ok: true }));

describe("FR-01 register", () => {
  it("creates account and returns set-auth-token header", async () => {
    const res = await register("alice", "password123");
    expect(res.ok).toBe(true);
    expect(res.headers.get("set-auth-token")).toBeTruthy();
  });

  it("duplicate username → 409 username_taken", async () => {
    await register("bob", "password123");
    const dup = await register("bob", "password123");
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "username_taken" });
  });

  it("password shorter than 8 → 400 password_too_short", async () => {
    const res = await register("carol", "short");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "password_too_short" });
  });

  it("repeatPassword mismatch → 400 password_mismatch (server-side)", async () => {
    const res = await register("dave", "password123", "different123");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "password_mismatch" });
  });

  it("username failing /^[a-z0-9_]{3,20}$/ → 400 bad_request", async () => {
    const res = await register("Bad User!", "password123");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("malformed JSON body → 400 bad_request", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it('no email field is accepted or returned; response JSON contains no "@users.tavern.invalid"', async () => {
    const res = await register("erin", "password123");
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).not.toContain("@users.tavern.invalid");
    const body: unknown = JSON.parse(text);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('"email"');
    expect(serialized).not.toContain('"emailVerified"');
  });
});

describe("FR-02 login", () => {
  it("valid credentials → 200 + set-auth-token header", async () => {
    await register("frank", "password123");
    const res = await login("frank", "password123", "203.0.113.11");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-auth-token")).toBeTruthy();
  });

  it("wrong password → 401-class generic invalid credentials (no user enumeration)", async () => {
    await register("grace", "password123");
    const wrong = await login("grace", "wrongpassword", "203.0.113.12");
    const unknown = await login("nobodyxyz", "wrongpassword", "203.0.113.13");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Identical body for wrong-password vs unknown-username → no enumeration oracle.
    expect(await wrong.text()).toEqual(await unknown.text());
  });

  it("bearer token authorizes a requireAuth route", async () => {
    await register("heidi", "password123");
    const res = await login("heidi", "password123", "203.0.113.14");
    const token = must(res.headers.get("set-auth-token"), "no set-auth-token on login");
    const authed = await probe.request(
      `${BASE}/probe`,
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(authed.status).toBe(200);
    expect(await authed.json()).toMatchObject({ userId: expect.any(String) });
  });

  it("cookie session authorizes a requireAuth route", async () => {
    await register("ivan", "password123");
    const res = await login("ivan", "password123", "203.0.113.15");
    const setCookie = must(res.headers.get("set-cookie"), "no set-cookie on login");
    const cookie = must(setCookie.split(";")[0], "empty set-cookie");
    const authed = await probe.request(`${BASE}/probe`, { headers: { cookie } }, env);
    expect(authed.status).toBe(200);
    expect(await authed.json()).toMatchObject({ userId: expect.any(String) });
  });

  it("unauthenticated requireAuth route → 401 unauthorized", async () => {
    const res = await probe.request(`${BASE}/probe`, {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("getSession round-trip returns userId + username + displayName, never email", async () => {
    await register("judy", "password123");
    const res = await login("judy", "password123", "203.0.113.16");
    const token = must(res.headers.get("set-auth-token"), "no set-auth-token on login");
    const sessionRes = await SELF.fetch(`${BASE}/api/auth/get-session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sessionRes.status).toBe(200);
    const text = await sessionRes.text();
    expect(text).not.toContain("@users.tavern.invalid");
    expect(text).not.toContain('"email"');
    expect(JSON.parse(text)).toMatchObject({
      user: { id: expect.any(String), username: "judy", displayName: "judy" },
    });
  });

  it("zodJson rejects a bad body with 400 bad_request and passes a valid one", async () => {
    const bad = await probe.request(
      `${BASE}/validated`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: "nope" }),
      },
      env,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad_request" });

    const notJson = await probe.request(
      `${BASE}/validated`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
      env,
    );
    expect(notJson.status).toBe(400);

    const ok = await probe.request(
      `${BASE}/validated`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 42 }),
      },
      env,
    );
    expect(ok.status).toBe(200);
  });
});

describe("FR-02 brute force", () => {
  it("4th sign-in attempt within 10s → 429 rate_limited (counter persisted in D1)", async () => {
    await register("kate", "password123");
    const addr = "203.0.113.50";
    const r1 = await login("kate", "wrongpass", addr);
    const r2 = await login("kate", "wrongpass", addr);
    const r3 = await login("kate", "wrongpass", addr);
    const r4 = await login("kate", "wrongpass", addr);
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);
    expect(r3.status).not.toBe(429);
    expect(r4.status).toBe(429);
    // storage="database": the count lives in the rate_limit table, not per-isolate memory.
    const row = await env.DB.prepare("SELECT count FROM rate_limit WHERE key LIKE ?")
      .bind(`%${addr}%`)
      .first<{ count: number }>();
    expect(row).not.toBeNull();
    expect(must(row, "no rate_limit row").count).toBeGreaterThanOrEqual(3);
  });
});
