import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@tavern/shared";
import { HangoutsModule } from "../../src/do/hangouts";

type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;

let roomSeq = 0;
function freshRoom(): RoomStub {
  roomSeq += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`hangouts-${Date.now()}-${roomSeq}`));
}

const T0 = 1_700_000_000_000;

describe("Tavern Home hangouts", () => {
  it("publishes exact two-person overlap and excludes solo time", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const hangouts = new HangoutsModule(state.storage.sql);
      hangouts.noteVoiceChange([a], [a, b], T0);
      hangouts.noteVoiceChange([a, b], [a], T0 + 90_000);

      expect(hangouts.finalizeDue(T0 + 90_000 + LIMITS.hangoutReconnectGraceMs)).toBe(true);
      expect(hangouts.recent()).toEqual([
        {
          id: expect.any(Number),
          participantIds: [a, b].toSorted(),
          startedAt: T0,
          endedAt: T0 + 90_000,
          sharedDurationMs: 90_000,
        },
      ]);
    });
  });

  it("drops accidental overlap shorter than one minute", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const hangouts = new HangoutsModule(state.storage.sql);
      hangouts.noteVoiceChange([a], [a, b], T0);
      hangouts.noteVoiceChange([a, b], [], T0 + 59_999);

      expect(hangouts.finalizeDue(T0 + 120_000)).toBe(false);
      expect(hangouts.recent()).toEqual([]);
    });
  });

  it("merges a brief reconnect but excludes the reconnect gap from duration", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const hangouts = new HangoutsModule(state.storage.sql);
      hangouts.noteVoiceChange([a], [a, b], T0);
      hangouts.noteVoiceChange([a, b], [a], T0 + 40_000);
      hangouts.noteVoiceChange([a], [a, b], T0 + 70_000);
      hangouts.noteVoiceChange([a, b], [a], T0 + 100_000);
      hangouts.finalizeDue(T0 + 160_000);

      const summary = hangouts.recent()[0];
      expect(summary?.participantIds).toEqual([a, b].toSorted());
      expect(summary?.sharedDurationMs).toBe(70_000);
      expect(summary?.endedAt).toBe(T0 + 100_000);
    });
  });

  it("splits conversations when shared presence resumes after the grace period", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const hangouts = new HangoutsModule(state.storage.sql);
      hangouts.noteVoiceChange([a], [a, b], T0);
      hangouts.noteVoiceChange([a, b], [a], T0 + 70_000);
      expect(hangouts.noteVoiceChange([a], [a, b], T0 + 131_000)).toBe(true);
      hangouts.noteVoiceChange([a, b], [], T0 + 201_000);
      hangouts.finalizeDue(T0 + 261_000);

      expect(hangouts.recent()).toHaveLength(2);
      expect(hangouts.recent().map((hangout) => hangout.sharedDurationMs)).toEqual([
        70_000, 70_000,
      ]);
    });
  });

  it("backfills existing voice activity once", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM home_migrations WHERE key = 'hangouts-v1'`);
      state.storage.sql.exec(`DELETE FROM activity`);
      state.storage.sql.exec(
        `INSERT INTO activity(type, user_id, meta, created_at) VALUES
         ('voice.join', ?, '{}', ?), ('voice.join', ?, '{}', ?),
         ('voice.leave', ?, '{}', ?), ('voice.leave', ?, '{}', ?)`,
        a,
        T0,
        b,
        T0 + 1_000,
        b,
        T0 + 71_000,
        a,
        T0 + 72_000,
      );
      const hangouts = new HangoutsModule(state.storage.sql);
      hangouts.backfill(T0 + 200_000);
      hangouts.backfill(T0 + 300_000);

      expect(hangouts.recent()).toHaveLength(1);
      expect(hangouts.recent()[0]?.sharedDurationMs).toBe(70_000);
    });
  });
});
