import { Hono } from "hono";
import { z } from "zod";
import type { ErrorCode } from "@tavern/shared";
import type { AuthVars } from "../middleware";

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

export const testSeedRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

testSeedRoute.post("/seed-shares", async (c) => {
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
