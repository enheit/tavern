import { LIMITS, Screenshot } from "@tavern/shared";
import { TavernError } from "./soundboard";
import type { Actor } from "./soundboard";

// The `screenshots` registry (§ screenshots tab). Plain functions over the DO's SQLite (mirrors
// soundboard.ts): the ServerRoom wires the internal routes, the Worker route owns the R2 put/delete.
// A row records WHO captured the still and WHEN; the image bytes live in R2 under the deterministic
// `{serverId}/screenshots/{id}.webp` key (built by the route, handed back here for delete cleanup).
type ScreenshotRow = Record<string, SqlStorageValue>;

// SQL read-back is a trust boundary (§9.8 / A9): validate the wire shape with the shared schema. The
// r2_key column is registry-internal (not part of the wire type) so it is read separately by getOwner.
function rowToScreenshot(row: ScreenshotRow): Screenshot {
  return Screenshot.parse({
    id: String(row["id"]),
    capturedBy: String(row["captured_by"]),
    createdAt: Number(row["created_at"]),
  });
}

// Finalized screenshots, newest first (§ screenshots tab ordering).
export function listScreenshots(
  sql: SqlStorage,
  offset = 0,
  limit?: number,
): {
  screenshots: Screenshot[];
  hasMore: boolean;
} {
  const take = Math.min(Math.max(1, limit ?? LIMITS.historyPageSize), LIMITS.historyPageSize);
  const rows = sql
    .exec<ScreenshotRow>(
      `SELECT id, captured_by, created_at FROM screenshots ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      take + 1,
      offset,
    )
    .toArray()
    .map(rowToScreenshot);
  return { screenshots: rows.slice(0, take), hasMore: rows.length > take };
}

// Inserts a captured screenshot row. `r2Key` is the stored `{serverId}/screenshots/{id}.webp` object
// key (the route already PUT the bytes there; deleteScreenshot hands it back for R2 cleanup).
export function createScreenshot(
  sql: SqlStorage,
  s: { id: string; capturedBy: string; r2Key: string; createdAt: number },
): Screenshot {
  sql.exec(
    `INSERT INTO screenshots (id, captured_by, r2_key, created_at) VALUES (?, ?, ?, ?)`,
    s.id,
    s.capturedBy,
    s.r2Key,
    s.createdAt,
  );
  return { id: s.id, capturedBy: s.capturedBy, createdAt: s.createdAt };
}

// The stored capturer + r2 key of a screenshot (the columns the wire type omits) — used to authorize a
// delete and hand the R2 key back to the Worker for object deletion.
function getOwner(
  sql: SqlStorage,
  screenshotId: string,
): { capturedBy: string; r2Key: string } | null {
  const rows = sql
    .exec<ScreenshotRow>(`SELECT captured_by, r2_key FROM screenshots WHERE id = ?`, screenshotId)
    .toArray();
  const row = rows[0];
  if (row === undefined) return null;
  return { capturedBy: String(row["captured_by"]), r2Key: String(row["r2_key"]) };
}

// Deletes a screenshot row. Only the capturer (or an admin) may remove it. Returns the stored R2 key so
// the Worker deletes the object. Throws not_found / forbidden (the route maps these to 404 / 403).
export function deleteScreenshot(
  sql: SqlStorage,
  screenshotId: string,
  actor: Actor,
): { r2Key: string } {
  const owner = getOwner(sql, screenshotId);
  if (owner === null) throw new TavernError("not_found");
  if (owner.capturedBy !== actor.userId && !actor.isAdmin) throw new TavernError("forbidden");
  sql.exec(`DELETE FROM screenshots WHERE id = ?`, screenshotId);
  return { r2Key: owner.r2Key };
}
