import { env, SELF } from "cloudflare:test";
import { CloudflareUsageResponse, MediaUsageCategory } from "@tavern/shared";
import { describe, expect, it, vi } from "vitest";
import { refreshCloudflareUsage } from "../src/lib/cloudflareUsage";

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

async function seedCache(
  source: string,
  payload: unknown,
  status: "ready" | "stale" | "unavailable" = "ready",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cloudflare_usage_cache
       (source, payload_json, status, updated_at, attempted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       payload_json = excluded.payload_json,
       status = excluded.status,
       updated_at = excluded.updated_at,
       attempted_at = excluded.attempted_at`,
  )
    .bind(
      source,
      typeof payload === "string" ? payload : JSON.stringify(payload),
      status,
      1234,
      1234,
    )
    .run();
}

async function authenticatedUsage(username: string): Promise<CloudflareUsageResponse> {
  const response = await SELF.fetch(`${BASE}/api/me/cloudflare-usage`, {
    headers: { authorization: `Bearer ${await session(username)}` },
  });
  expect(response.status).toBe(200);
  return CloudflareUsageResponse.parse(await response.json());
}

function graphqlResponse(query: string): Response {
  if (query.includes("r2OperationsAdaptiveGroups")) {
    return Response.json({
      data: {
        viewer: {
          accounts: [
            { r2OperationsAdaptiveGroups: [{ sum: { requests: 2 } }, { sum: { requests: 3 } }] },
          ],
        },
      },
    });
  }
  if (query.includes("d1AnalyticsAdaptiveGroups")) {
    return Response.json({
      data: {
        viewer: {
          accounts: [
            {
              d1AnalyticsAdaptiveGroups: [
                { sum: { rowsRead: 5, rowsWritten: 1 } },
                { sum: { rowsRead: 2, rowsWritten: 2 } },
              ],
            },
          ],
        },
      },
    });
  }
  if (query.includes("workersInvocationsAdaptive")) {
    return Response.json({
      data: {
        viewer: {
          accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 12, errors: 1 } }] }],
        },
      },
    });
  }
  if (query.includes("callsTurnUsageAdaptiveGroups")) {
    return Response.json({
      data: {
        viewer: {
          accounts: [
            { callsTurnUsageAdaptiveGroups: [{ sum: { ingressBytes: 100, egressBytes: 200 } }] },
          ],
        },
      },
    });
  }
  return Response.json({ errors: [{ message: "unexpected query" }], data: null });
}

function inputUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

const unavailableFetch: typeof fetch = async () => new Response(null, { status: 503 });

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

  it("returns every cached source, including nullable metrics from successful refreshes", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO media_usage_inventory_state (singleton, reconciled_at) VALUES (1, ?)",
      ).bind(1111),
      env.DB.prepare(
        `INSERT INTO media_usage_inventory (r2_key, category, size_bytes, updated_at)
           VALUES (?, ?, ?, ?)`,
      ).bind("market-icons/server/item.webp", "marketIcons", 2048, 1111),
    ]);
    await seedCache("r2", { operations: 10 });
    await seedCache("d1", { storageBytes: null, rowsRead: 20, rowsWritten: 3 });
    await seedCache("durableObjects", { requests: 30, cpuTimeMs: 4.5, storageBytes: 4096 });
    await seedCache("worker", { requests: 40, errors: 2, cpuTimeMs: null });
    await seedCache("turn", { ingressBytes: 50, egressBytes: 60 });
    await seedCache("analyticsEngine", { pointsWritten: 70 });

    const body = await authenticatedUsage("cloudflare_cached");

    expect(body.media).toMatchObject({
      status: "ready",
      bytes: 2048,
      objectCount: 1,
      reconciledAt: 1111,
    });
    expect(body.r2).toEqual({ status: "ready", updatedAt: 1234, operations: 10 });
    expect(body.d1).toEqual({
      status: "ready",
      updatedAt: 1234,
      storageBytes: null,
      rowsRead: 20,
      rowsWritten: 3,
    });
    expect(body.durableObjects).toEqual({
      status: "ready",
      updatedAt: 1234,
      requests: 30,
      cpuTimeMs: 4.5,
      storageBytes: 4096,
    });
    expect(body.worker).toEqual({
      status: "ready",
      updatedAt: 1234,
      requests: 40,
      errors: 2,
      cpuTimeMs: null,
    });
    expect(body.turn).toEqual({
      status: "ready",
      updatedAt: 1234,
      ingressBytes: 50,
      egressBytes: 60,
    });
    expect(body.analyticsEngine).toEqual({
      status: "ready",
      updatedAt: 1234,
      pointsWritten: 70,
    });
  });

  it("keeps valid stale data while rejecting unavailable and malformed cache rows", async () => {
    await seedCache("r2", {}, "unavailable");
    await seedCache("d1", "not-json");
    await seedCache("durableObjects", { requests: -1, cpuTimeMs: null, storageBytes: 0 });
    await seedCache("turn", { ingressBytes: 80, egressBytes: 90 }, "stale");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const body = await authenticatedUsage("cf_invalid_cache");

    expect(body.r2).toMatchObject({ status: "unavailable", operations: null });
    expect(body.d1).toMatchObject({ status: "unavailable", rowsRead: null });
    expect(body.durableObjects).toMatchObject({ status: "unavailable", requests: null });
    expect(body.turn).toEqual({
      status: "stale",
      updatedAt: 1234,
      ingressBytes: 80,
      egressBytes: 90,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Cloudflare usage cache is invalid",
      expect.objectContaining({ source: "d1" }),
    );
    consoleError.mockRestore();
  });

  it("refreshes and aggregates every configured remote Cloudflare source", async () => {
    await env.DB.prepare(
      `INSERT INTO media_usage_inventory_state (singleton, reconciled_at) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET reconciled_at = excluded.reconciled_at`,
    )
      .bind(1111)
      .run();
    const configuredEnv: Env = {
      ...env,
      CLOUDFLARE_ANALYTICS_TOKEN: "analytics-token",
      TURN_KEY_ID: "turn-key",
    };
    const requests: Array<{ url: URL; authorization: string | null; body: string }> = [];
    const remoteFetch: typeof fetch = async (input, init) => {
      const url = inputUrl(input);
      const body = typeof init?.body === "string" ? init.body : "";
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });
      if (url.pathname.endsWith("/analytics_engine/sql")) {
        return Response.json({ data: [{ points_written: "15" }] });
      }
      const request = JSON.parse(body) as { query: string };
      return graphqlResponse(request.query);
    };

    await refreshCloudflareUsage(configuredEnv, false, remoteFetch);
    const body = await authenticatedUsage("cf_refreshed");

    expect(requests).toHaveLength(5);
    expect(requests.every((request) => request.authorization === "Bearer analytics-token")).toBe(
      true,
    );
    expect(requests.some((request) => request.body.includes('"keyId":"turn-key"'))).toBe(true);
    expect(body.r2).toMatchObject({ status: "ready", operations: 5 });
    expect(body.d1).toMatchObject({ status: "ready", rowsRead: 7, rowsWritten: 3 });
    expect(body.worker).toMatchObject({
      status: "ready",
      requests: 12,
      errors: 1,
      cpuTimeMs: null,
    });
    expect(body.turn).toMatchObject({ status: "ready", ingressBytes: 100, egressBytes: 200 });
    expect(body.analyticsEngine).toMatchObject({ status: "ready", pointsWritten: 15 });
  });

  it("marks the last successful cache stale when a remote refresh fails", async () => {
    await env.DB.prepare("DELETE FROM cloudflare_usage_cache").run();
    await seedCache("r2", { operations: 99 });
    const configuredEnv: Env = {
      ...env,
      CLOUDFLARE_ANALYTICS_TOKEN: "analytics-token",
      TURN_KEY_ID: "turn-key",
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await refreshCloudflareUsage(configuredEnv, false, unavailableFetch);
    const body = await authenticatedUsage("cf_stale");

    expect(body.r2).toMatchObject({ status: "stale", operations: 99 });
    expect(body.d1).toMatchObject({ status: "unavailable", rowsRead: null });
    expect(body.worker).toMatchObject({ status: "unavailable", requests: null });
    expect(body.analyticsEngine).toMatchObject({ status: "unavailable", pointsWritten: null });
    expect(consoleError).toHaveBeenCalledTimes(5);
    consoleError.mockRestore();
  });
});
