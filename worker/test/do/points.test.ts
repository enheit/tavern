import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PointsModule } from "../../src/do/points";

type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;

let roomSeq = 0;
function freshRoom(): RoomStub {
  roomSeq += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`points-${Date.now()}-${roomSeq}`));
}

const T0 = Date.UTC(2026, 6, 13, 12);

describe("server points ledger", () => {
  it("ranks every requested member by settled balance and includes zero-point members", async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const third = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      points.replaceSources({ conversation: [second], streaming: [first], watching: [first] }, T0);

      expect(points.leaderboard([second, third, first], T0 + 2 * 60_000)).toEqual([
        { userId: first, balance: 20 },
        { userId: second, balance: 10 },
        { userId: third, balance: 0 },
      ]);
    });
  });

  it("projects leaderboard reads and identical eligibility without rewriting the ledger", async () => {
    const userId = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      const eligibility = { conversation: [userId], streaming: [], watching: [] };
      points.replaceSources(eligibility, T0);

      expect(points.leaderboard([userId], T0 + 2 * 60_000)).toEqual([{ userId, balance: 10 }]);
      points.replaceSources(eligibility, T0 + 2 * 60_000);

      const source = state.storage.sql
        .exec<{ started_at: number }>(
          `SELECT started_at FROM point_sources WHERE user_id = ? AND source = 'conversation'`,
          userId,
        )
        .one();
      const accounts = state.storage.sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM point_accounts`)
        .one();
      expect(source.started_at).toBe(T0);
      expect(accounts.count).toBe(0);
    });
  });

  it("does not award conversation points to a solo member", async () => {
    const userId = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      points.replaceSources({ conversation: [], streaming: [], watching: [] }, T0);
      points.settle(T0 + 10 * 60_000);

      expect(points.snapshot(userId, T0 + 10 * 60_000)).toMatchObject({
        balance: 0,
        currentRatePerMinute: 0,
        today: { conversation: 0, total: 0 },
      });
    });
  });

  it("stacks each eligible source once and never multiplies duplicate viewers", async () => {
    const userId = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      points.replaceSources(
        {
          conversation: [userId, userId],
          streaming: [userId, userId],
          watching: [userId, userId],
        },
        T0,
      );
      expect(points.snapshot(userId, T0).currentRatePerMinute).toBe(15);

      points.settle(T0 + 60_000);
      expect(points.snapshot(userId, T0 + 60_000)).toMatchObject({
        balance: 15,
        today: { conversation: 5, streaming: 5, watching: 5, total: 15 },
      });
      points.settle(T0 + 60_000);
      expect(points.snapshot(userId, T0 + 60_000).balance).toBe(15);
    });
  });

  it("preserves partial minutes across eligibility changes without crediting inactive time", async () => {
    const userId = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      points.replaceSources({ conversation: [userId], streaming: [], watching: [] }, T0);
      points.replaceSources({ conversation: [], streaming: [], watching: [] }, T0 + 30_000);
      points.replaceSources(
        { conversation: [userId], streaming: [], watching: [] },
        T0 + 10 * 60_000,
      );
      points.replaceSources(
        { conversation: [], streaming: [], watching: [] },
        T0 + 10 * 60_000 + 30_000,
      );

      expect(points.snapshot(userId, T0 + 11 * 60_000)).toMatchObject({
        balance: 5,
        today: { conversation: 5, total: 5 },
      });
    });
  });

  it("settles old rates before a live configuration change", async () => {
    const userId = crypto.randomUUID();
    const adminId = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      points.replaceSources({ conversation: [userId], streaming: [], watching: [] }, T0);
      points.updateConfig(
        {
          enabled: true,
          basePointsPerMinute: 10,
          streamerBonusPerMinute: 5,
          watcherBonusPerMinute: 5,
          dailyCap: null,
        },
        adminId,
        T0 + 60_000,
      );
      points.settle(T0 + 2 * 60_000);

      expect(points.snapshot(userId, T0 + 2 * 60_000)).toMatchObject({
        balance: 15,
        currentRatePerMinute: 10,
        today: { conversation: 15, total: 15 },
      });
    });
  });

  it("enforces the configured daily cap across all sources", async () => {
    const userId = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      points.updateConfig(
        {
          enabled: true,
          basePointsPerMinute: 5,
          streamerBonusPerMinute: 5,
          watcherBonusPerMinute: 5,
          dailyCap: 12,
        },
        crypto.randomUUID(),
        T0,
      );
      points.replaceSources(
        { conversation: [userId], streaming: [userId], watching: [userId] },
        T0,
      );
      points.settle(T0 + 2 * 60_000);

      const snapshot = points.snapshot(userId, T0 + 2 * 60_000);
      expect(snapshot.balance).toBe(12);
      expect(snapshot.today.total).toBe(12);
    });
  });
});
