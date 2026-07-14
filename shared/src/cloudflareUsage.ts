import { z } from "zod";

export const CloudflareUsageStatus = z.enum(["ready", "stale", "unavailable"]);
export type CloudflareUsageStatus = z.infer<typeof CloudflareUsageStatus>;

const UsageSource = z.object({
  status: CloudflareUsageStatus,
  updatedAt: z.number().int().nonnegative().nullable(),
});

export const MediaUsageCategory = z.enum([
  "avatars",
  "soundboardAudio",
  "recordings",
  "screenshots",
  "chatImages",
  "marketIcons",
  "other",
]);
export type MediaUsageCategory = z.infer<typeof MediaUsageCategory>;

export const MediaUsageEntry = z.object({
  category: MediaUsageCategory,
  bytes: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
});
export type MediaUsageEntry = z.infer<typeof MediaUsageEntry>;

export const CloudflareUsageResponse = z.object({
  periodStart: z.number().int().nonnegative(),
  periodEnd: z.number().int().nonnegative(),
  media: UsageSource.extend({
    bytes: z.number().int().nonnegative().nullable(),
    objectCount: z.number().int().nonnegative().nullable(),
    categories: z.array(MediaUsageEntry),
    reconciledAt: z.number().int().nonnegative().nullable(),
  }),
  r2: UsageSource.extend({ operations: z.number().int().nonnegative().nullable() }),
  d1: UsageSource.extend({
    storageBytes: z.number().int().nonnegative().nullable(),
    rowsRead: z.number().int().nonnegative().nullable(),
    rowsWritten: z.number().int().nonnegative().nullable(),
  }),
  durableObjects: UsageSource.extend({
    requests: z.number().int().nonnegative().nullable(),
    cpuTimeMs: z.number().nonnegative().nullable(),
    storageBytes: z.number().int().nonnegative().nullable(),
  }),
  worker: UsageSource.extend({
    requests: z.number().int().nonnegative().nullable(),
    errors: z.number().int().nonnegative().nullable(),
    cpuTimeMs: z.number().nonnegative().nullable(),
  }),
  turn: UsageSource.extend({
    ingressBytes: z.number().int().nonnegative().nullable(),
    egressBytes: z.number().int().nonnegative().nullable(),
  }),
  analyticsEngine: UsageSource.extend({ pointsWritten: z.number().int().nonnegative().nullable() }),
  sfu: UsageSource,
  rateLimiter: UsageSource,
  staticAssets: UsageSource,
});
export type CloudflareUsageResponse = z.infer<typeof CloudflareUsageResponse>;
