import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://tavern.test";

async function register(username: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
  const token = res.headers.get("set-auth-token");
  if (!res.ok || token === null) throw new Error(`register failed: ${res.status}`);
  return token;
}

function post(token: string | null, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/qoe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

const sample = {
  role: "viewer",
  platform: "web",
  os: "web",
  streamKind: "screen",
  contentMode: "motion",
  preset: "1080p60",
  codec: "VP9",
  rid: "h",
  limitation: "bandwidth",
  health: "network_limited",
  targetFps: 60,
  sourceFps: null,
  encodeFps: null,
  receiveFps: 48,
  renderFps: 46,
  width: 1920,
  height: 1080,
  bitrateKbps: 4200,
  lossPct: 3.2,
  rttMs: 82,
  jitterMs: 8,
  droppedPct: 1.4,
  freezeMs: 600,
  sampleWindowMs: 5000,
};

describe("POST /api/qoe", () => {
  it("requires authentication", async () => {
    const res = await post(null, { v: 1, samples: [sample] });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts a bounded anonymous quality batch", async () => {
    const token = await register("qoe_writer");
    const res = await post(token, { v: 1, samples: [sample] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects metrics outside the shared bounds", async () => {
    const token = await register("qoe_invalid");
    const res = await post(token, {
      v: 1,
      samples: [{ ...sample, lossPct: 101 }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});
