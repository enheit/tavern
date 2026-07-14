import { LIMITS, MarketItem } from "@tavern/shared";
import type {
  EquippedMarketIcon,
  ErrorCode,
  MarketItem as MarketItemValue,
  MarketPage,
  PointSnapshot,
} from "@tavern/shared";
import type { PointsModule } from "./points";

type MarketRow = {
  id: string;
  kind: "icon";
  name: string;
  price: number;
  revision: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  buyer_id: string | null;
  buyer_display_name: string | null;
  price_paid: number | null;
  purchased_at: number | null;
};

export type MarketMutationResult<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

const PAGE_SIZE = Math.min(24, LIMITS.historyPageSize);

function encodeCursor(offset: number): string {
  return btoa(String(offset));
}

function decodeCursor(cursor: string | null): number | null {
  if (cursor === null) return 0;
  try {
    const value = Number(atob(cursor));
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function rowToItem(row: MarketRow): MarketItemValue {
  const purchase =
    row.buyer_id === null ||
    row.buyer_display_name === null ||
    row.price_paid === null ||
    row.purchased_at === null
      ? null
      : {
          buyerId: row.buyer_id,
          buyerDisplayName: row.buyer_display_name,
          pricePaid: row.price_paid,
          purchasedAt: row.purchased_at,
        };
  return MarketItem.parse({
    id: row.id,
    kind: row.kind,
    name: row.name,
    price: row.price,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    purchase,
  });
}

function iconFromItem(item: MarketItemValue): EquippedMarketIcon | null {
  if (item.purchase === null) return null;
  return {
    itemId: item.id,
    name: item.name,
    pricePaid: item.purchase.pricePaid,
    purchasedAt: item.purchase.purchasedAt,
  };
}

export class MarketModule {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly points: PointsModule,
  ) {}

  page(scope: "shop" | "owned", userId: string, cursor: string | null): MarketPage | null {
    const offset = decodeCursor(cursor);
    if (offset === null) return null;
    const rows =
      scope === "owned"
        ? this.storage.sql
            .exec<MarketRow>(
              `${this.selectSql()}
               WHERE p.buyer_id = ?
               ORDER BY p.purchased_at DESC, i.id DESC LIMIT ? OFFSET ?`,
              userId,
              PAGE_SIZE + 1,
              offset,
            )
            .toArray()
        : this.storage.sql
            .exec<MarketRow>(
              `${this.selectSql()}
               ORDER BY CASE WHEN p.item_id IS NULL THEN 0 ELSE 1 END,
                        i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`,
              PAGE_SIZE + 1,
              offset,
            )
            .toArray();
    const hasMore = rows.length > PAGE_SIZE;
    return {
      items: rows.slice(0, PAGE_SIZE).map(rowToItem),
      nextCursor: hasMore ? encodeCursor(offset + PAGE_SIZE) : null,
    };
  }

  create(input: {
    id: string;
    name: string;
    price: number;
    createdBy: string;
    r2Key: string;
    now: number;
  }): MarketItemValue {
    this.storage.sql.exec(
      `INSERT INTO market_items(
         id, kind, name, price, revision, created_by, r2_key, created_at, updated_at)
       VALUES (?, 'icon', ?, ?, 1, ?, ?, ?, ?)`,
      input.id,
      input.name,
      input.price,
      input.createdBy,
      input.r2Key,
      input.now,
      input.now,
    );
    return this.item(input.id);
  }

  patch(
    itemId: string,
    patch: { name?: string | undefined; price?: number | undefined },
    now: number,
  ): MarketMutationResult<MarketItemValue> {
    const result = this.storage.transactionSync<ErrorCode | null>(() => {
      if (!this.exists(itemId)) return "not_found";
      if (this.isSold(itemId)) return "market_item_frozen";
      if (patch.name !== undefined && patch.price !== undefined) {
        this.storage.sql.exec(
          `UPDATE market_items SET name = ?, price = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
          patch.name,
          patch.price,
          now,
          itemId,
        );
      } else if (patch.name !== undefined) {
        this.storage.sql.exec(
          `UPDATE market_items SET name = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
          patch.name,
          now,
          itemId,
        );
      } else if (patch.price !== undefined) {
        this.storage.sql.exec(
          `UPDATE market_items SET price = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
          patch.price,
          now,
          itemId,
        );
      }
      return null;
    });
    return result === null ? { ok: true, value: this.item(itemId) } : { ok: false, code: result };
  }

  delete(itemId: string): MarketMutationResult<{ itemId: string; r2Key: string }> {
    let r2Key = "";
    const result = this.storage.transactionSync<ErrorCode | null>(() => {
      const row = this.storage.sql
        .exec<{ r2_key: string }>(`SELECT r2_key FROM market_items WHERE id = ?`, itemId)
        .toArray()[0];
      if (row === undefined) return "not_found";
      if (this.isSold(itemId)) return "market_item_frozen";
      r2Key = row.r2_key;
      this.storage.sql.exec(`INSERT OR IGNORE INTO market_asset_cleanup(r2_key) VALUES (?)`, r2Key);
      this.storage.sql.exec(`DELETE FROM market_items WHERE id = ?`, itemId);
      return null;
    });
    return result === null ? { ok: true, value: { itemId, r2Key } } : { ok: false, code: result };
  }

  purchase(input: {
    itemId: string;
    userId: string;
    displayName: string;
    expectedRevision: number;
    wearImmediately: boolean;
    now: number;
  }): MarketMutationResult<{
    item: MarketItemValue;
    points: PointSnapshot;
    equippedIcon: EquippedMarketIcon | null;
  }> {
    const result = this.storage.transactionSync<ErrorCode | null>(() => {
      const existing = this.purchaseOwner(input.itemId);
      if (existing !== null) {
        if (existing !== input.userId) return "market_sold";
        if (input.wearImmediately) this.setEquipped(input.userId, input.itemId);
        return null;
      }
      const item = this.itemOrNull(input.itemId);
      if (item === null) return "not_found";
      if (item.revision !== input.expectedRevision) return "market_item_changed";
      this.points.settleUser(input.userId, input.now);
      if (!this.points.debitForMarket(input.userId, item.price, input.now)) {
        return "insufficient_points";
      }
      this.storage.sql.exec(
        `INSERT INTO market_purchases(
           item_id, buyer_id, buyer_display_name, price_paid, purchased_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.itemId,
        input.userId,
        input.displayName,
        item.price,
        input.now,
      );
      if (input.wearImmediately) this.setEquipped(input.userId, input.itemId);
      return null;
    });
    if (result !== null) return { ok: false, code: result };
    return {
      ok: true,
      value: {
        item: this.item(input.itemId),
        points: this.points.snapshot(input.userId, input.now),
        equippedIcon: this.equipped(input.userId),
      },
    };
  }

  equip(userId: string, itemId: string | null): MarketMutationResult<EquippedMarketIcon | null> {
    if (itemId === null) {
      this.storage.sql.exec(`DELETE FROM market_equipped_icons WHERE user_id = ?`, userId);
      return { ok: true, value: null };
    }
    if (this.purchaseOwner(itemId) !== userId) {
      return { ok: false, code: "market_icon_not_owned" };
    }
    this.setEquipped(userId, itemId);
    return { ok: true, value: this.equipped(userId) };
  }

  equipped(userId: string): EquippedMarketIcon | null {
    const row = this.storage.sql
      .exec<MarketRow>(
        `${this.selectSql()}
         INNER JOIN market_equipped_icons e ON e.item_id = i.id
         WHERE e.user_id = ?`,
        userId,
      )
      .toArray()[0];
    return row === undefined ? null : iconFromItem(rowToItem(row));
  }

  pendingAssetCleanup(): string[] {
    return this.storage.sql
      .exec<{ r2_key: string }>(`SELECT r2_key FROM market_asset_cleanup ORDER BY r2_key`)
      .toArray()
      .map((row) => row.r2_key);
  }

  completeAssetCleanup(r2Key: string): void {
    this.storage.sql.exec(`DELETE FROM market_asset_cleanup WHERE r2_key = ?`, r2Key);
  }

  private item(itemId: string): MarketItemValue {
    const item = this.itemOrNull(itemId);
    if (item === null) throw new Error(`market item missing after mutation: ${itemId}`);
    return item;
  }

  private itemOrNull(itemId: string): MarketItemValue | null {
    const row = this.storage.sql
      .exec<MarketRow>(`${this.selectSql()} WHERE i.id = ?`, itemId)
      .toArray()[0];
    return row === undefined ? null : rowToItem(row);
  }

  private exists(itemId: string): boolean {
    return (
      this.storage.sql
        .exec<{ id: string }>(`SELECT id FROM market_items WHERE id = ?`, itemId)
        .toArray()[0] !== undefined
    );
  }

  private isSold(itemId: string): boolean {
    return this.purchaseOwner(itemId) !== null;
  }

  private purchaseOwner(itemId: string): string | null {
    return (
      this.storage.sql
        .exec<{ buyer_id: string }>(
          `SELECT buyer_id FROM market_purchases WHERE item_id = ?`,
          itemId,
        )
        .toArray()[0]?.buyer_id ?? null
    );
  }

  private setEquipped(userId: string, itemId: string): void {
    this.storage.sql.exec(
      `INSERT INTO market_equipped_icons(user_id, item_id) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET item_id = excluded.item_id`,
      userId,
      itemId,
    );
  }

  private selectSql(): string {
    return `SELECT i.id, i.kind, i.name, i.price, i.revision, i.created_by,
                   i.created_at, i.updated_at, p.buyer_id, p.buyer_display_name,
                   p.price_paid, p.purchased_at
            FROM market_items i
            LEFT JOIN market_purchases p ON p.item_id = i.id`;
  }
}
