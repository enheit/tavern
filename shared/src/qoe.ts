import { z } from "zod";
import { PresetIdSchema } from "./domain";
import { SCREEN_RIDS } from "./presets";

export const QoeHealthSchema = z.enum([
  "healthy",
  "adapting",
  "device_limited",
  "network_limited",
  "poor",
]);
export type QoeHealth = z.infer<typeof QoeHealthSchema>;

export const QoeLimitationSchema = z.enum([
  "none",
  "capture",
  "cpu",
  "bandwidth",
  "decoder",
  "unknown",
]);
export type QoeLimitation = z.infer<typeof QoeLimitationSchema>;

const finiteMetric = (max: number) => z.number().finite().min(0).max(max).nullable();

// Anonymous, bounded media-quality measurement. No account, server, session, room, track, IP, or
// source-name field exists in this contract, so the ingestion route cannot accidentally persist one.
export const QoeSampleSchema = z.object({
  role: z.enum(["publisher", "viewer"]),
  platform: z.enum(["web", "desktop"]),
  os: z.enum(["web", "win32", "darwin", "linux", "other"]),
  streamKind: z.enum(["screen", "webcam"]),
  contentMode: z.enum(["detail", "balanced", "motion"]),
  preset: PresetIdSchema.nullable(),
  codec: z.string().trim().min(1).max(32).nullable(),
  rid: z.enum([...SCREEN_RIDS, "unknown"]).nullable(),
  limitation: QoeLimitationSchema,
  health: QoeHealthSchema,
  targetFps: z.number().int().min(1).max(120),
  sourceFps: finiteMetric(240),
  encodeFps: finiteMetric(240),
  receiveFps: finiteMetric(240),
  renderFps: finiteMetric(240),
  width: z.number().int().min(0).max(8192).nullable(),
  height: z.number().int().min(0).max(8192).nullable(),
  bitrateKbps: finiteMetric(100_000),
  lossPct: finiteMetric(100),
  rttMs: finiteMetric(60_000),
  jitterMs: finiteMetric(60_000),
  droppedPct: finiteMetric(100),
  freezeMs: finiteMetric(300_000),
  sampleWindowMs: z.number().int().min(1_000).max(300_000),
});
export type QoeSample = z.infer<typeof QoeSampleSchema>;

export const QoeBatchRequest = z.object({
  v: z.literal(1),
  samples: z.array(QoeSampleSchema).min(1).max(32),
});
export type QoeBatchRequest = z.infer<typeof QoeBatchRequest>;

export const QoeResponse = z.object({ ok: z.literal(true) });
export type QoeResponse = z.infer<typeof QoeResponse>;
