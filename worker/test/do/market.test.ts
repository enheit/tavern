import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MarketModule } from "../../src/do/market";
import { PointsModule } from "../../src/do/points";

type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;

let sequence = 0;
const T0 = Date.UTC(2026, 6, 14, 12);

function freshRoom(): RoomStub {
  sequence += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`market-${Date.now()}-${sequence}`));
}

function createItem(market: MarketModule, creatorId: string, price = 40) {
  const id = crypto.randomUUID();
  return market.create({
    id,
    name: "Animated fox",
    price,
    createdBy: creatorId,
    r2Key: `market-icons/server/${id}.webp`,
    now: T0,
  });
}

describe("server market", () => {
  it("atomically charges exactly one buyer and makes same-buyer retries idempotent", async () => {
    const creatorId = crypto.randomUUID();
    const buyerId = crypto.randomUUID();
    const rivalId = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      const market = new MarketModule(state.storage, points);
      const item = createItem(market, creatorId);
      points.setBalanceForTest(buyerId, 100, T0);
      points.setBalanceForTest(rivalId, 100, T0);

      const purchase = market.purchase({
        itemId: item.id,
        userId: buyerId,
        displayName: "Buyer",
        expectedRevision: item.revision,
        wearImmediately: false,
        now: T0 + 1,
      });
      expect(purchase).toMatchObject({
        ok: true,
        value: {
          points: { balance: 60 },
          equippedIcon: null,
          item: { purchase: { buyerId, pricePaid: 40 } },
        },
      });

      expect(
        market.purchase({
          itemId: item.id,
          userId: rivalId,
          displayName: "Rival",
          expectedRevision: item.revision,
          wearImmediately: true,
          now: T0 + 2,
        }),
      ).toEqual({ ok: false, code: "market_sold" });
      expect(points.snapshot(rivalId, T0 + 2).balance).toBe(100);

      const retry = market.purchase({
        itemId: item.id,
        userId: buyerId,
        displayName: "Buyer",
        expectedRevision: item.revision,
        wearImmediately: true,
        now: T0 + 3,
      });
      expect(retry).toMatchObject({
        ok: true,
        value: { points: { balance: 60 }, equippedIcon: { itemId: item.id } },
      });
      expect(market.equip(buyerId, null)).toEqual({ ok: true, value: null });
    });
  });

  it("rejects stale prices and insufficient balances without changing either ledger", async () => {
    const creatorId = crypto.randomUUID();
    const buyerId = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      const market = new MarketModule(state.storage, points);
      const original = createItem(market, creatorId, 80);
      points.setBalanceForTest(buyerId, 50, T0);
      const patched = market.patch(original.id, { price: 90 }, T0 + 1);
      if (!patched.ok) throw new Error(patched.code);

      expect(
        market.purchase({
          itemId: original.id,
          userId: buyerId,
          displayName: "Buyer",
          expectedRevision: original.revision,
          wearImmediately: false,
          now: T0 + 2,
        }),
      ).toEqual({ ok: false, code: "market_item_changed" });
      expect(
        market.purchase({
          itemId: original.id,
          userId: buyerId,
          displayName: "Buyer",
          expectedRevision: patched.value.revision,
          wearImmediately: false,
          now: T0 + 3,
        }),
      ).toEqual({ ok: false, code: "insufficient_points" });
      expect(points.snapshot(buyerId, T0 + 3).balance).toBe(50);
      expect(market.page("shop", buyerId, null)?.items[0]?.purchase).toBeNull();
    });
  });

  it("freezes sold rows while unsold deletion enters the durable asset cleanup queue", async () => {
    const creatorId = crypto.randomUUID();
    const buyerId = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      const market = new MarketModule(state.storage, points);
      const sold = createItem(market, creatorId, 10);
      const unsold = createItem(market, creatorId, 20);
      points.setBalanceForTest(buyerId, 100, T0);
      expect(
        market.purchase({
          itemId: sold.id,
          userId: buyerId,
          displayName: "Buyer",
          expectedRevision: sold.revision,
          wearImmediately: false,
          now: T0 + 1,
        }),
      ).toMatchObject({ ok: true });

      expect(market.patch(sold.id, { name: "Changed" }, T0 + 2)).toEqual({
        ok: false,
        code: "market_item_frozen",
      });
      expect(market.delete(sold.id)).toEqual({ ok: false, code: "market_item_frozen" });
      expect(market.equip(creatorId, sold.id)).toEqual({
        ok: false,
        code: "market_icon_not_owned",
      });

      expect(market.delete(unsold.id)).toMatchObject({ ok: true, value: { itemId: unsold.id } });
      expect(market.pendingAssetCleanup()).toEqual([`market-icons/server/${unsold.id}.webp`]);
    });
  });
});
