import { Hono } from "hono";
import { z } from "zod";
import type { ErrorCode } from "@tavern/shared";
import type { AuthVars } from "../middleware";
import { sfuMockStateForTest } from "../rtc/realtimeMock";

// Test-only seed route (S8.5, PLAN §10). MOUNTED by index.ts ONLY behind the mock-SFU env guard
// (TAVERN_SFU_MOCK=1, the PR/e2e worker env): in production the flag is absent, so /api/__test/* 404s
// at router assembly and this module is unreachable. `POST /api/__test/seed-shares { serverId, count }`
// registers `count` synthetic active SCREEN shares in the server's DO RTC registry so an e2e can
// exercise the G4 concurrent-share cap (§8 G4) without publishing real media.

// A generous upper bound (well past LIMITS.maxConcurrentScreenShares) so a test can seed at or above
// the cap; keeps a malformed request from registering an unbounded number of synthetic rows.
const SEED_CAP = 50;

const seedSharesBody = z.object({
  serverId: z.string(),
  count: z.number().int().min(0).max(SEED_CAP),
});

const doResSchema = z.object({ screens: z.number() });
const seedPointsBody = z.object({
  serverId: z.uuid(),
  userId: z.uuid(),
  balance: z.number().int().nonnegative(),
});
const removeMembersBody = z.object({
  serverId: z.uuid(),
  userIds: z.array(z.uuid()).min(1).max(10),
});

export const testSeedRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

testSeedRoute.post("/seed-shares", async (c) => {
  // Mock-SFU only (the index.ts mount now also opens /api/__test for TAVERN_TEST=1 — re-check the
  // original narrower guard here so the real-SFU nightly worker still 404s this route).
  if (c.env.TAVERN_SFU_MOCK !== "1") return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  const parsed = seedSharesBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const { serverId, count } = parsed.data;
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(serverId));
  const res = await stub.fetch("https://do.internal/internal/test/seed-shares", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
    body: JSON.stringify({ count }),
  });
  return c.json(doResSchema.parse(await res.json()));
});

// S12.3 egress seeding forwarder (§8 kill-switch e2e). Double-guarded: the /api/__test mount already
// requires TAVERN_SFU_MOCK=1 at router assembly, and this route ADDITIONALLY requires TAVERN_TEST=1
// (404 without it — same shape as the DO handler's own re-check). The e2e env sets both flags in
// .dev.vars.e2e; production sets neither, so the route does not exist there in any configuration.
const setEgressBody = z.object({
  serverId: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  bytes: z.number().int().nonnegative(),
});

// One-time server-creation code seeding (FR-08 hardening e2e). POST /api/__test/seed-code inserts a
// fresh unused code into `server_creation_codes` and returns it, so e2e/soak flows can create
// servers without an operator manually running `wrangler d1 execute`. Guarded like set-egress:
// TAVERN_TEST=1 required (set in .dev.vars.e2e AND the nightly real-SFU .dev.vars); production sets
// neither test flag, so the route does not exist there in any configuration.
testSeedRoute.post("/seed-code", async (c) => {
  if (c.env.TAVERN_TEST !== "1") return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  const code = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO server_creation_codes (code, created_at) VALUES (?, ?)")
    .bind(code, Date.now())
    .run();
  return c.json({ code });
});

testSeedRoute.post("/seed-points", async (c) => {
  if (c.env.TAVERN_TEST !== "1") return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  const parsed = seedPointsBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const { serverId, userId, balance } = parsed.data;
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(serverId));
  const res = await stub.fetch("https://do.internal/internal/test/seed-points", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
    body: JSON.stringify({ userId, balance }),
  });
  if (!res.ok) return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  const body: unknown = await res.json();
  return c.json(body);
});

// Local/e2e crowd cleanup. Directly seeded memberships still need the same DO eviction as an admin
// kick; deleting only D1 would leave stale people in the room snapshot. This route exists only when
// TAVERN_TEST=1 and performs both source-of-truth deletion and cache/socket eviction in that order.
testSeedRoute.post("/remove-members", async (c) => {
  if (c.env.TAVERN_TEST !== "1") return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  const parsed = removeMembersBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const { serverId, userIds } = parsed.data;
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(serverId));
  await Promise.all(
    userIds.map(async (userId) => {
      await c.env.DB.prepare("DELETE FROM memberships WHERE user_id = ? AND server_id = ?")
        .bind(userId, serverId)
        .run();
      await stub.fetch("https://do.internal/internal/kick", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
        body: JSON.stringify({ userId, by: userId }),
      });
    }),
  );
  return c.json({ removed: userIds.length });
});

// Mock-SFU state readout (Task-1 diagnostics): the mock keeps its published-track registry in
// isolate-local module state; this exposes it (plus a per-isolate id) so the multi-client voice
// e2e can prove whether a "track_not_found" streak is registry truth or isolate/state loss.
testSeedRoute.get("/sfu-mock-state", (c) => {
  if (c.env.TAVERN_SFU_MOCK !== "1") return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  return c.json(sfuMockStateForTest());
});

testSeedRoute.post("/set-egress", async (c) => {
  if (c.env.TAVERN_TEST !== "1") return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  const parsed = setEgressBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const { serverId, month, bytes } = parsed.data;
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(serverId));
  const res = await stub.fetch("https://do.internal/internal/test/set-egress", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tavern-Internal": "1" },
    body: JSON.stringify({ month, bytes }),
  });
  if (!res.ok) return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  return c.json({});
});
