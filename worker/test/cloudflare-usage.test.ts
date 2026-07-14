import { SELF } from "cloudflare:test";
import { CloudflareUsageResponse, MediaUsageCategory } from "@tavern/shared";
import { describe, expect, it } from "vitest";

const BASE = "https://tavern.test";

async function session(username: string): Promise<string> {
  const response = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
  const token = response.headers.get("set-auth-token");
  if (!response.ok || token === null) throw new Error(`register failed: ${response.status}`);
  return token;
}

describe("GET /api/me/cloudflare-usage", () => {
  it("requires a session and returns an aggregate-only schema without analytics configuration", async () => {
    const anonymous = await SELF.fetch(`${BASE}/api/me/cloudflare-usage`);
    expect(anonymous.status).toBe(401);

    const response = await SELF.fetch(`${BASE}/api/me/cloudflare-usage`, {
      headers: { authorization: `Bearer ${await session("cloudflare_usage")}` },
    });
    expect(response.status).toBe(200);
    const body = CloudflareUsageResponse.parse(await response.json());
    expect(body.media.categories).toHaveLength(MediaUsageCategory.options.length);
    expect(body.r2.operations).toBeNull();
    expect(JSON.stringify(body)).not.toContain("tavern-media");
  });
});
