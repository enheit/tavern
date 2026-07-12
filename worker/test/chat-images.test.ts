import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

// § chat image paste — worker routes. Proves the user's two concerns directly: (1) a pasted/dropped
// image is uploaded to OUR server as bytes and served back from OUR R2 (no third party, no hotlink),
// and (2) the upload answers a cross-origin (desktop `app://tavern`) CORS preflight, so the desktop
// renderer is never blocked. Also covers the from-url ingest's SSRF guard + happy path.

const BASE = "https://tavern.test";

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function uname(): string {
  return `u${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function session(username: string): Promise<string> {
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

function json(token: string, method: string, path: string, body: unknown): Promise<Response> {
  return authed(token, path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createServer(token: string, nickname: string): Promise<string> {
  const code = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO server_creation_codes (code, created_at) VALUES (?, ?)")
    .bind(code, Date.now())
    .run();
  const res = await json(token, "POST", "/api/servers", { nickname, password: "hunter2", code });
  if (res.status !== 201) throw new Error(`create server: ${res.status} ${await res.text()}`);
  const body: { id: string } = await res.json();
  return body.id;
}

// A fresh server; the returned token is the creator (a member).
async function freshServer(): Promise<{ serverId: string; token: string }> {
  const nickname = `s-${crypto.randomUUID().slice(0, 8)}`;
  const token = await session(uname());
  const serverId = await createServer(token, nickname);
  return { serverId, token };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function uploadBytes(token: string, serverId: string, bytes: Uint8Array, type: string) {
  return authed(token, `/api/servers/${serverId}/chat-images`, {
    method: "POST",
    headers: { "content-type": type },
    body: bytes,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat image upload (bytes → our R2)", () => {
  it("a member uploads image bytes and gets them served back from our own capability URL", async () => {
    const { serverId, token } = await freshServer();

    const res = await uploadBytes(token, serverId, PNG_BYTES, "image/webp");
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(UUID_RE);

    // The bytes are in OUR R2 under the deterministic server-first key.
    const object = await env.MEDIA.get(`${serverId}/chat-images/${id}.webp`);
    expect(object).not.toBeNull();

    // ...and the PUBLIC capability route serves them back (no auth), same-origin to the chat.
    const view = await SELF.fetch(`${BASE}/api/chat-images/${serverId}/${id}.webp`);
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await view.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("rejects a non-image content-type (415) and an empty body (400)", async () => {
    const { serverId, token } = await freshServer();
    expect((await uploadBytes(token, serverId, PNG_BYTES, "text/plain")).status).toBe(415);
    expect((await uploadBytes(token, serverId, new Uint8Array(0), "image/webp")).status).toBe(400);
  });

  it("a non-member cannot upload (403)", async () => {
    const { serverId } = await freshServer();
    const outsider = await session(uname());
    expect((await uploadBytes(outsider, serverId, PNG_BYTES, "image/webp")).status).toBe(403);
  });
});

describe("chat image upload — CORS (desktop app://tavern)", () => {
  it("answers the cross-origin preflight so the desktop renderer is never blocked", async () => {
    const { serverId } = await freshServer();
    const res = await SELF.fetch(`${BASE}/api/servers/${serverId}/chat-images`, {
      method: "OPTIONS",
      headers: {
        origin: "app://tavern",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe("app://tavern");
  });
});

describe("chat image from-url (worker fetches remote — no browser CORS)", () => {
  it("blocks a private/loopback host (SSRF guard, 400) before any fetch", async () => {
    const { serverId, token } = await freshServer();
    const res = await json(token, "POST", `/api/servers/${serverId}/chat-images/from-url`, {
      url: "http://127.0.0.1/secret.png",
      width: 10,
      height: 10,
    });
    expect(res.status).toBe(400);
  });

  it("fetches a public image server-side and stores it in our R2", async () => {
    const { serverId, token } = await freshServer();
    const realFetch = globalThis.fetch;
    // Pass-through stub: fake only our target URL, delegate everything else (so SELF dispatch is intact).
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://cdn.example.com/cat.png") {
        return Promise.resolve(
          new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
        );
      }
      return realFetch(input as RequestInfo, init);
    });

    const res = await json(token, "POST", `/api/servers/${serverId}/chat-images/from-url`, {
      url: "https://cdn.example.com/cat.png",
      width: 10,
      height: 10,
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(UUID_RE);

    const view = await SELF.fetch(`${BASE}/api/chat-images/${serverId}/${id}.webp`);
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await view.arrayBuffer())).toEqual(PNG_BYTES);
  });
});
