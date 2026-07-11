import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// S12.3 guard proof (§8): the egress seeding route MUST NOT exist without TAVERN_TEST=1. This
// project's miniflare bindings deliberately set TAVERN_SFU_MOCK=1 (so /api/__test/* is mounted and
// the request reaches the route) but NOT TAVERN_TEST — the 404s below prove the second guard alone
// keeps the seeding surface closed. The positive path is exercised by e2e/web/killswitch.spec.ts
// against the e2e env (which sets both flags); the meter math is covered by cost-meter.test.ts.

const BASE = "https://tavern.test";

describe("§8 egress test route guard", () => {
  it("worker forwarder /api/__test/set-egress → 404 without TAVERN_TEST", async () => {
    const res = await SELF.fetch(`${BASE}/api/__test/set-egress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId: "s1", month: "2026-07", bytes: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("DO /internal/test/set-egress → bodyless 404 without TAVERN_TEST (even from the Worker)", async () => {
    const stub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName("guard-test"));
    const res = await stub.fetch("https://do.internal/internal/test/set-egress", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
      body: JSON.stringify({ month: "2026-07", bytes: 1 }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});
