import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@tavern/shared";
import { PointsModule } from "../../src/do/points";
import { PollsModule } from "../../src/do/polls";

type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;
let sequence = 0;
const T0 = Date.UTC(2026, 6, 13, 12);

function freshRoom(): RoomStub {
  sequence += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`polls-${Date.now()}-${sequence}`));
}

function createPoll(polls: PollsModule, creatorId: string) {
  const result = polls.create({
    creatorId,
    creatorDisplayName: "Creator",
    question: "Who wins?",
    outcomes: ["Blue", "Red"],
    durationSeconds: 60,
    now: T0,
  });
  if (!result.ok) throw new Error(result.code);
  return result.poll;
}

describe("poll point ledger", () => {
  it("escrows final bids and distributes the complete pool proportionally after the hold", async () => {
    const creator = crypto.randomUUID();
    const blueUser = crypto.randomUUID();
    const redUser = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      const polls = new PollsModule(state.storage, points);
      points.setBalanceForTest(blueUser, 100, T0);
      points.setBalanceForTest(redUser, 100, T0);
      const poll = createPoll(polls, creator);
      const blue = poll.outcomes[0];
      const red = poll.outcomes[1];
      if (blue === undefined || red === undefined) throw new Error("outcomes missing");

      expect(
        polls.bid({
          pollId: poll.id,
          outcomeId: blue.id,
          userId: blueUser,
          displayName: "Blue user",
          stake: 25,
          now: T0 + 1,
        }),
      ).toMatchObject({ ok: true });
      expect(
        polls.bid({
          pollId: poll.id,
          outcomeId: red.id,
          userId: redUser,
          displayName: "Red user",
          stake: 75,
          now: T0 + 2,
        }),
      ).toMatchObject({ ok: true });
      expect(points.snapshot(blueUser, T0 + 2).balance).toBe(75);
      expect(points.snapshot(redUser, T0 + 2).balance).toBe(25);

      expect(polls.lock(poll.id, creator, false, T0 + 3)).toMatchObject({ ok: true });
      expect(polls.resolve(poll.id, blue.id, creator, false, T0 + 4)).toMatchObject({ ok: true });
      expect(points.snapshot(blueUser, T0 + 4)).toMatchObject({
        balance: 75,
        pendingPollWinnings: 100,
      });
      expect(points.snapshot(redUser, T0 + 4)).toMatchObject({
        balance: 25,
        pendingPollWinnings: 0,
      });

      polls.processDue(T0 + 4 + LIMITS.pollCorrectionHoldMs);
      expect(points.snapshot(blueUser, T0 + 4 + LIMITS.pollCorrectionHoldMs).balance).toBe(175);
      expect(points.snapshot(redUser, T0 + 4 + LIMITS.pollCorrectionHoldMs).balance).toBe(25);
      expect(polls.poll(poll.id, blueUser).status).toBe("finalized");
    });
  });

  it("allows exactly one correction during the hold without debiting a mistaken payout", async () => {
    const creator = crypto.randomUUID();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      const polls = new PollsModule(state.storage, points);
      points.setBalanceForTest(first, 100, T0);
      points.setBalanceForTest(second, 100, T0);
      const poll = createPoll(polls, creator);
      const blue = poll.outcomes[0];
      const red = poll.outcomes[1];
      if (blue === undefined || red === undefined) throw new Error("outcomes missing");
      polls.bid({
        pollId: poll.id,
        outcomeId: blue.id,
        userId: first,
        displayName: "First",
        stake: 40,
        now: T0 + 1,
      });
      polls.bid({
        pollId: poll.id,
        outcomeId: red.id,
        userId: second,
        displayName: "Second",
        stake: 60,
        now: T0 + 2,
      });
      polls.lock(poll.id, creator, false, T0 + 3);
      polls.resolve(poll.id, blue.id, creator, false, T0 + 4);

      expect(polls.correct(poll.id, red.id, creator, false, T0 + 5)).toMatchObject({ ok: true });
      expect(points.snapshot(first, T0 + 5).pendingPollWinnings).toBe(0);
      expect(points.snapshot(second, T0 + 5).pendingPollWinnings).toBe(100);
      expect(polls.correct(poll.id, blue.id, creator, false, T0 + 6)).toEqual({
        ok: false,
        code: "correction_used",
      });
      expect(polls.void(poll.id, creator, false, T0 + 6)).toEqual({
        ok: false,
        code: "correction_used",
      });
    });
  });

  it("refunds every stake on void and enforces one final bid plus the creator poll cap", async () => {
    const creator = crypto.randomUUID();
    const user = crypto.randomUUID();
    await runInDurableObject(freshRoom(), (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      const polls = new PollsModule(state.storage, points);
      points.setBalanceForTest(user, 50, T0);
      const poll = createPoll(polls, creator);
      const outcome = poll.outcomes[0];
      if (outcome === undefined) throw new Error("outcome missing");
      expect(
        polls.bid({
          pollId: poll.id,
          outcomeId: outcome.id,
          userId: user,
          displayName: "User",
          stake: 30,
          now: T0 + 1,
        }),
      ).toMatchObject({ ok: true });
      expect(
        polls.bid({
          pollId: poll.id,
          outcomeId: outcome.id,
          userId: user,
          displayName: "User",
          stake: 1,
          now: T0 + 2,
        }),
      ).toEqual({ ok: false, code: "already_bid" });
      expect(polls.void(poll.id, creator, false, T0 + 3)).toMatchObject({ ok: true });
      expect(points.snapshot(user, T0 + 3).balance).toBe(50);

      for (let index = 0; index < LIMITS.pollMaxUnresolvedPerCreator; index += 1)
        createPoll(polls, creator);
      expect(
        polls.create({
          creatorId: creator,
          creatorDisplayName: "Creator",
          question: "One too many?",
          outcomes: ["Yes", "No"],
          durationSeconds: 60,
          now: T0 + 10,
        }),
      ).toEqual({ ok: false, code: "poll_limit" });
    });
  });
});
