import { CloudflareUsageResponse } from "@tavern/shared";
import type { CloudflareUsageStatus } from "@tavern/shared";
import { z } from "zod";
import { readMediaUsage, reconcileMediaInventory } from "./mediaUsageInventory";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_SOURCES = ["r2", "d1", "durableObjects", "worker", "turn", "analyticsEngine"] as const;
type CacheSource = (typeof CACHE_SOURCES)[number];

type CacheRow = {
  payload_json: string;
  status: CloudflareUsageStatus;
  updated_at: number | null;
};

const GraphqlEnvelope = z.object({
  data: z.unknown().nullable(),
  errors: z
    .array(z.object({ message: z.string() }))
    .nullable()
    .optional(),
});

const R2Result = z.object({
  viewer: z.object({
    accounts: z.array(
      z.object({
        r2OperationsAdaptiveGroups: z.array(z.object({ sum: z.object({ requests: z.number() }) })),
      }),
    ),
  }),
});

const D1Result = z.object({
  viewer: z.object({
    accounts: z.array(
      z.object({
        d1AnalyticsAdaptiveGroups: z.array(
          z.object({
            sum: z.object({ rowsRead: z.number(), rowsWritten: z.number() }),
          }),
        ),
      }),
    ),
  }),
});

const WorkerResult = z.object({
  viewer: z.object({
    accounts: z.array(
      z.object({
        workersInvocationsAdaptive: z.array(
          z.object({
            sum: z.object({ requests: z.number(), errors: z.number() }),
          }),
        ),
      }),
    ),
  }),
});

const TurnResult = z.object({
  viewer: z.object({
    accounts: z.array(
      z.object({
        callsTurnUsageAdaptiveGroups: z.array(
          z.object({ sum: z.object({ ingressBytes: z.number(), egressBytes: z.number() }) }),
        ),
      }),
    ),
  }),
});

const AnalyticsEngineResult = z.object({
  data: z.array(z.object({ points_written: z.coerce.number().nullable() })),
});

function startOfUtcMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function toUtcDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function toUtcTime(time: number): string {
  return new Date(time).toISOString();
}

function total<T>(rows: readonly T[], value: (row: T) => number): number {
  return rows.reduce((sum, row) => sum + value(row), 0);
}

async function queryGraphql(
  env: Env,
  query: string,
  variables: Record<string, string>,
  fetcher: typeof fetch,
): Promise<unknown> {
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (
    token === undefined ||
    token.trim() === "" ||
    accountId === undefined ||
    accountId.trim() === ""
  ) {
    throw new Error("Cloudflare analytics is not configured");
  }
  const response = await fetcher(GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { accountTag: accountId, ...variables } }),
  });
  if (!response.ok) throw new Error(`Cloudflare GraphQL request failed with ${response.status}`);
  const envelope = GraphqlEnvelope.parse(await response.json());
  if (envelope.errors !== undefined && envelope.errors !== null && envelope.errors.length > 0) {
    throw new Error(
      `Cloudflare GraphQL error: ${envelope.errors.map((error) => error.message).join("; ")}`,
    );
  }
  if (envelope.data === null) throw new Error("Cloudflare GraphQL returned no data");
  return envelope.data;
}

async function saveCache(db: D1Database, source: CacheSource, payload: object): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO cloudflare_usage_cache (source, payload_json, status, updated_at, attempted_at)
       VALUES (?, ?, 'ready', ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         payload_json = excluded.payload_json,
         status = 'ready',
         updated_at = excluded.updated_at,
         attempted_at = excluded.attempted_at`,
    )
    .bind(source, JSON.stringify(payload), now, now)
    .run();
}

async function markCacheFailure(
  db: D1Database,
  source: CacheSource,
  error: unknown,
): Promise<void> {
  const now = Date.now();
  const existing = await db
    .prepare("SELECT status FROM cloudflare_usage_cache WHERE source = ?")
    .bind(source)
    .first<{ status: CloudflareUsageStatus }>();
  if (existing === null || existing.status === "unavailable") {
    await db
      .prepare(
        `INSERT INTO cloudflare_usage_cache (source, payload_json, status, updated_at, attempted_at)
         VALUES (?, '{}', 'unavailable', NULL, ?)`,
      )
      .bind(source, now)
      .run();
  } else {
    await db
      .prepare(
        "UPDATE cloudflare_usage_cache SET status = 'stale', attempted_at = ? WHERE source = ?",
      )
      .bind(now, source)
      .run();
  }
  console.error("Cloudflare usage refresh failed", {
    source,
    error: error instanceof Error ? error.message : String(error),
  });
}

async function refreshSource(
  db: D1Database,
  source: CacheSource,
  refresh: () => Promise<object>,
): Promise<void> {
  try {
    await saveCache(db, source, await refresh());
  } catch (error: unknown) {
    await markCacheFailure(db, source, error);
  }
}

const R2_QUERY = `query TavernR2($accountTag: string!, $start: Time!, $end: Time!, $bucketName: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end, bucketName: $bucketName }) {
      sum { requests }
    }
  } }
}`;

const D1_QUERY = `query TavernD1($accountTag: string!, $start: Date!, $end: Date!, $databaseId: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end, databaseId: $databaseId }) {
      sum { rowsRead rowsWritten }
    }
  } }
}`;

const WORKER_QUERY = `query TavernWorker($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 10000, filter: { scriptName: "tavern", datetime_geq: $start, datetime_leq: $end }) {
      sum { requests errors }
    }
  } }
}`;

const TURN_QUERY = `query TavernTurn($accountTag: string!, $start: Date!, $end: Date!, $keyId: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    callsTurnUsageAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end, keyId: $keyId }) {
      sum { ingressBytes egressBytes }
    }
  } }
}`;

async function refreshRemoteUsage(
  env: Env,
  periodStart: number,
  periodEnd: number,
  fetcher: typeof fetch,
): Promise<void> {
  if (env.CLOUDFLARE_ANALYTICS_TOKEN === undefined || env.CLOUDFLARE_ACCOUNT_ID === undefined)
    return;
  const dateVariables = { start: toUtcDate(periodStart), end: toUtcDate(periodEnd) };
  const timeVariables = { start: toUtcTime(periodStart), end: toUtcTime(periodEnd) };
  await Promise.all([
    refreshSource(env.DB, "r2", async () => {
      const data = R2Result.parse(
        await queryGraphql(
          env,
          R2_QUERY,
          { ...timeVariables, bucketName: "tavern-media" },
          fetcher,
        ),
      );
      const rows = data.viewer.accounts[0]?.r2OperationsAdaptiveGroups ?? [];
      return { operations: total(rows, (row) => row.sum.requests) };
    }),
    refreshSource(env.DB, "d1", async () => {
      const data = D1Result.parse(
        await queryGraphql(
          env,
          D1_QUERY,
          {
            ...dateVariables,
            databaseId: "49d52212-7fd9-4d4e-a7dd-d48f90dc0219",
          },
          fetcher,
        ),
      );
      const rows = data.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups ?? [];
      return {
        rowsRead: total(rows, (row) => row.sum.rowsRead),
        rowsWritten: total(rows, (row) => row.sum.rowsWritten),
        storageBytes: null,
      };
    }),
    refreshSource(env.DB, "worker", async () => {
      const data = WorkerResult.parse(
        await queryGraphql(env, WORKER_QUERY, timeVariables, fetcher),
      );
      const rows = data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
      return {
        requests: total(rows, (row) => row.sum.requests),
        errors: total(rows, (row) => row.sum.errors),
        cpuTimeMs: null,
      };
    }),
    refreshSource(env.DB, "turn", async () => {
      const keyId = env.TURN_KEY_ID;
      if (keyId === undefined || keyId.trim() === "") throw new Error("TURN key is not configured");
      const data = TurnResult.parse(
        await queryGraphql(env, TURN_QUERY, { ...dateVariables, keyId }, fetcher),
      );
      const rows = data.viewer.accounts[0]?.callsTurnUsageAdaptiveGroups ?? [];
      return {
        ingressBytes: total(rows, (row) => row.sum.ingressBytes),
        egressBytes: total(rows, (row) => row.sum.egressBytes),
      };
    }),
    refreshSource(env.DB, "analyticsEngine", async () => {
      const token = env.CLOUDFLARE_ANALYTICS_TOKEN;
      const accountId = env.CLOUDFLARE_ACCOUNT_ID;
      if (token === undefined || accountId === undefined)
        throw new Error("Cloudflare analytics is not configured");
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: `SELECT SUM(_sample_interval) AS points_written FROM tavern_qoe_v1 WHERE timestamp >= toDateTime('${new Date(periodStart).toISOString().slice(0, 19).replace("T", " ")}') FORMAT JSON`,
        },
      );
      if (!response.ok) throw new Error(`Analytics Engine query failed with ${response.status}`);
      const data = AnalyticsEngineResult.parse(await response.json());
      return { pointsWritten: data.data[0]?.points_written ?? 0 };
    }),
  ]);
}

export async function refreshCloudflareUsage(
  env: Env,
  reconcile: boolean,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const media = await readMediaUsage(env.DB);
  if (reconcile || media.reconciledAt === null) await reconcileMediaInventory(env.DB, env.MEDIA);
  const now = Date.now();
  await refreshRemoteUsage(env, startOfUtcMonth(now), now, fetcher);
}

async function cachePayload<T extends z.ZodType>(
  db: D1Database,
  source: CacheSource,
  schema: T,
): Promise<{ status: CloudflareUsageStatus; updatedAt: number | null; data: z.infer<T> | null }> {
  const row = await db
    .prepare("SELECT payload_json, status, updated_at FROM cloudflare_usage_cache WHERE source = ?")
    .bind(source)
    .first<CacheRow>();
  if (row === null || row.status === "unavailable")
    return { status: "unavailable", updatedAt: null, data: null };
  try {
    const parsed = schema.safeParse(JSON.parse(row.payload_json) as unknown);
    if (!parsed.success) return { status: "unavailable", updatedAt: null, data: null };
    return { status: row.status, updatedAt: row.updated_at, data: parsed.data };
  } catch (error: unknown) {
    console.error("Cloudflare usage cache is invalid", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "unavailable", updatedAt: null, data: null };
  }
}

export async function readCloudflareUsage(env: Env): Promise<CloudflareUsageResponse> {
  const now = Date.now();
  const [media, r2, d1, durableObjects, worker, turn, analyticsEngine] = await Promise.all([
    readMediaUsage(env.DB),
    cachePayload(env.DB, "r2", z.object({ operations: z.number().int().nonnegative() })),
    cachePayload(
      env.DB,
      "d1",
      z.object({
        storageBytes: z.number().int().nonnegative().nullable(),
        rowsRead: z.number().int().nonnegative(),
        rowsWritten: z.number().int().nonnegative(),
      }),
    ),
    cachePayload(
      env.DB,
      "durableObjects",
      z.object({
        requests: z.number().int().nonnegative(),
        cpuTimeMs: z.number().nonnegative().nullable(),
        storageBytes: z.number().int().nonnegative(),
      }),
    ),
    cachePayload(
      env.DB,
      "worker",
      z.object({
        requests: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        cpuTimeMs: z.number().nonnegative().nullable(),
      }),
    ),
    cachePayload(
      env.DB,
      "turn",
      z.object({
        ingressBytes: z.number().int().nonnegative(),
        egressBytes: z.number().int().nonnegative(),
      }),
    ),
    cachePayload(
      env.DB,
      "analyticsEngine",
      z.object({ pointsWritten: z.number().int().nonnegative() }),
    ),
  ]);
  return CloudflareUsageResponse.parse({
    periodStart: startOfUtcMonth(now),
    periodEnd: now,
    media: {
      status: media.reconciledAt === null ? "unavailable" : "ready",
      updatedAt: media.updatedAt,
      bytes: media.bytes,
      objectCount: media.objectCount,
      categories: media.categories,
      reconciledAt: media.reconciledAt,
    },
    r2: { status: r2.status, updatedAt: r2.updatedAt, operations: r2.data?.operations ?? null },
    d1: {
      status: d1.status,
      updatedAt: d1.updatedAt,
      storageBytes: d1.data?.storageBytes ?? null,
      rowsRead: d1.data?.rowsRead ?? null,
      rowsWritten: d1.data?.rowsWritten ?? null,
    },
    durableObjects: {
      status: durableObjects.status,
      updatedAt: durableObjects.updatedAt,
      requests: durableObjects.data?.requests ?? null,
      cpuTimeMs: durableObjects.data?.cpuTimeMs ?? null,
      storageBytes: durableObjects.data?.storageBytes ?? null,
    },
    worker: {
      status: worker.status,
      updatedAt: worker.updatedAt,
      requests: worker.data?.requests ?? null,
      errors: worker.data?.errors ?? null,
      cpuTimeMs: worker.data?.cpuTimeMs ?? null,
    },
    turn: {
      status: turn.status,
      updatedAt: turn.updatedAt,
      ingressBytes: turn.data?.ingressBytes ?? null,
      egressBytes: turn.data?.egressBytes ?? null,
    },
    analyticsEngine: {
      status: analyticsEngine.status,
      updatedAt: analyticsEngine.updatedAt,
      pointsWritten: analyticsEngine.data?.pointsWritten ?? null,
    },
    sfu: { status: "unavailable", updatedAt: null },
    rateLimiter: { status: "unavailable", updatedAt: null },
    staticAssets: { status: "unavailable", updatedAt: null },
  });
}
