import { Hono } from "hono";
import { QoeBatchRequest, QoeResponse } from "@tavern/shared";
import type { ErrorCode, QoeSample } from "@tavern/shared";
import type { AuthVars } from "../middleware";
import { requireAuth } from "../middleware";

function metric(value: number | null): number {
  return value ?? -1;
}

function anonymousIndex(role: QoeSample["role"]): string {
  const bucket = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
  return `qoe-v1:${role}:${bucket % 32}`;
}

export const qoeRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

qoeRoute.use("*", requireAuth);

qoeRoute.post("/", async (c) => {
  const userId = c.get("userId");
  if (userId === null) return c.json({ error: "unauthorized" satisfies ErrorCode }, 401);
  const limited = await c.env.QOE_RATE_LIMITER.limit({ key: userId });
  if (!limited.success) return c.json({ error: "rate_limited" satisfies ErrorCode }, 429);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }
  const parsed = QoeBatchRequest.safeParse(raw);
  if (!parsed.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);

  try {
    for (const sample of parsed.data.samples) {
      c.env.QOE_ANALYTICS.writeDataPoint({
        indexes: [anonymousIndex(sample.role)],
        blobs: [
          sample.role,
          sample.platform,
          sample.os,
          sample.streamKind,
          sample.contentMode,
          sample.preset ?? "none",
          sample.codec ?? "unknown",
          sample.rid ?? "none",
          sample.limitation,
          sample.health,
        ],
        doubles: [
          sample.targetFps,
          metric(sample.sourceFps),
          metric(sample.encodeFps),
          metric(sample.receiveFps),
          metric(sample.renderFps),
          metric(sample.width),
          metric(sample.height),
          metric(sample.bitrateKbps),
          metric(sample.lossPct),
          metric(sample.rttMs),
          metric(sample.jitterMs),
          metric(sample.droppedPct),
          metric(sample.freezeMs),
          sample.sampleWindowMs,
        ],
      });
    }
  } catch (err) {
    console.error("QoE Analytics Engine write failed", err);
    return c.json({ error: "bad_request" satisfies ErrorCode }, 500);
  }
  return c.json(QoeResponse.parse({ ok: true }));
});
