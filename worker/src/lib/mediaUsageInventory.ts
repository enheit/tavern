import { MediaUsageCategory, type MediaUsageEntry } from "@tavern/shared";

const MEDIA_CATEGORIES = MediaUsageCategory.options;

type MediaInventoryRow = {
  category: string;
  bytes: number;
  object_count: number;
};

type MediaInventoryStateRow = { reconciled_at: number | null };
type MediaInventorySummaryRow = MediaInventoryRow & { latest_updated_at: number | null };

export function mediaCategoryForKey(key: string): MediaUsageCategory {
  if (key.startsWith("avatars/")) return "avatars";
  if (key.startsWith("sounds/")) return "soundboardAudio";
  if (key.startsWith("recordings/")) return "recordings";
  if (key.startsWith("market-icons/")) return "marketIcons";
  if (/^[^/]+\/screenshots\//.test(key)) return "screenshots";
  if (/^[^/]+\/chat-images\//.test(key)) return "chatImages";
  return "other";
}

export async function recordMediaObject(db: D1Database, object: R2Object): Promise<void> {
  await db
    .prepare(
      `INSERT INTO media_usage_inventory (r2_key, category, size_bytes, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(r2_key) DO UPDATE SET
         category = excluded.category,
         size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at`,
    )
    .bind(object.key, mediaCategoryForKey(object.key), object.size, Date.now())
    .run();
}

export async function removeMediaObject(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM media_usage_inventory WHERE r2_key = ?").bind(key).run();
}

// Media storage is secondary to a user's upload/delete action: R2 remains the source of truth. If
// D1 is temporarily unavailable, log the discrepancy and let the hourly R2 reconciliation repair it.
export async function trackMediaInventory(
  task: Promise<void>,
  operation: "put" | "delete",
  key: string,
): Promise<void> {
  try {
    await task;
  } catch (error: unknown) {
    console.error("media usage inventory update failed", {
      operation,
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function reconcileMediaInventoryPage(
  db: D1Database,
  media: R2Bucket,
  startedAt: number,
  cursor?: string,
): Promise<void> {
  const page = await media.list({ limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
  const batches = Array.from({ length: Math.ceil(page.objects.length / 100) }, (_, index) =>
    page.objects.slice(index * 100, index * 100 + 100).map((object) =>
      db
        .prepare(
          `INSERT INTO media_usage_inventory (r2_key, category, size_bytes, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(r2_key) DO UPDATE SET
             category = excluded.category,
             size_bytes = excluded.size_bytes,
             updated_at = excluded.updated_at`,
        )
        .bind(object.key, mediaCategoryForKey(object.key), object.size, startedAt),
    ),
  );
  await Promise.all(batches.map((statements) => db.batch(statements)));
  if (page.truncated) {
    await reconcileMediaInventoryPage(db, media, startedAt, page.cursor);
  }
}

export async function reconcileMediaInventory(db: D1Database, media: R2Bucket): Promise<number> {
  const startedAt = Date.now();
  await reconcileMediaInventoryPage(db, media, startedAt);

  await db.batch([
    db.prepare("DELETE FROM media_usage_inventory WHERE updated_at < ?").bind(startedAt),
    db
      .prepare(
        `INSERT INTO media_usage_inventory_state (singleton, reconciled_at) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET reconciled_at = excluded.reconciled_at`,
      )
      .bind(Date.now()),
  ]);
  return startedAt;
}

export async function readMediaUsage(db: D1Database): Promise<{
  bytes: number;
  objectCount: number;
  categories: MediaUsageEntry[];
  reconciledAt: number | null;
  updatedAt: number | null;
}> {
  const [rows, state] = await Promise.all([
    db
      .prepare(
        `SELECT category, COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS object_count,
           MAX(updated_at) AS latest_updated_at
         FROM media_usage_inventory
         GROUP BY category`,
      )
      .all<MediaInventorySummaryRow>(),
    db
      .prepare("SELECT reconciled_at FROM media_usage_inventory_state WHERE singleton = 1")
      .first<MediaInventoryStateRow>(),
  ]);
  const byCategory = new Map(rows.results.map((row) => [row.category, row]));
  const categories = MEDIA_CATEGORIES.map((category) => {
    const row = byCategory.get(category);
    return {
      category,
      bytes: row === undefined ? 0 : Number(row.bytes),
      objectCount: row === undefined ? 0 : Number(row.object_count),
    };
  });
  return {
    bytes: categories.reduce((total, category) => total + category.bytes, 0),
    objectCount: categories.reduce((total, category) => total + category.objectCount, 0),
    categories,
    reconciledAt: state?.reconciled_at ?? null,
    updatedAt:
      rows.results.reduce(
        (latest, row) => Math.max(latest, row.latest_updated_at ?? 0),
        state?.reconciled_at ?? 0,
      ) || null,
  };
}
