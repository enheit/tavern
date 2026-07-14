import { LIMITS, Poll, PollPage } from "@tavern/shared";
import type { ErrorCode, Poll as PollValue, PollDetail } from "@tavern/shared";
import type { PointsModule } from "./points";

type PollRow = {
  id: string;
  creator_id: string;
  creator_display_name: string;
  question: string;
  status: PollValue["status"];
  created_at: number;
  closes_at: number;
  locked_at: number | null;
  resolved_at: number | null;
  finalizes_at: number | null;
  finalized_at: number | null;
  voided_at: number | null;
  winning_outcome_id: string | null;
  correction_used: number;
  result_visible_until: number | null;
};

type OutcomeRow = { id: string; title: string; total_points: number; bidder_count: number };
type BidRow = {
  user_id: string;
  display_name: string;
  outcome_id: string;
  stake: number;
  payout: number;
  placed_at: number;
};

export type PollMutationResult =
  | { ok: true; poll: PollValue; affectedUserIds: string[] }
  | { ok: false; code: ErrorCode };

export type PollDueResult = { polls: PollValue[]; affectedUserIds: string[] };

export class PollsModule {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly points: PointsModule,
  ) {}

  create(input: {
    creatorId: string;
    creatorDisplayName: string;
    question: string;
    outcomes: string[];
    durationSeconds: number;
    now: number;
  }): PollMutationResult {
    const question = input.question.trim();
    const titles = input.outcomes.map((title) => title.trim());
    if (
      question.length < 1 ||
      question.length > LIMITS.pollQuestionMaxChars ||
      !Number.isInteger(input.durationSeconds) ||
      input.durationSeconds < LIMITS.pollDurationMinSeconds ||
      input.durationSeconds > LIMITS.pollDurationMaxSeconds ||
      titles.length < LIMITS.pollOutcomeMin ||
      titles.length > LIMITS.pollOutcomeMax ||
      titles.some((title) => title.length < 1 || title.length > LIMITS.pollOutcomeMaxChars) ||
      new Set(titles.map((title) => title.toLocaleLowerCase())).size !== titles.length
    ) {
      return { ok: false, code: "bad_message" };
    }
    const id = crypto.randomUUID();
    const created = this.storage.transactionSync(() => {
      const count = this.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM polls
           WHERE creator_id = ? AND status IN ('open','locked')`,
          input.creatorId,
        )
        .one().count;
      if (count >= LIMITS.pollMaxUnresolvedPerCreator) return false;
      this.storage.sql.exec(
        `INSERT INTO polls(id, creator_id, creator_display_name, question, status, created_at, closes_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        id,
        input.creatorId,
        input.creatorDisplayName,
        question,
        input.now,
        input.now + input.durationSeconds * 1000,
      );
      for (const [position, title] of titles.entries()) {
        this.storage.sql.exec(
          `INSERT INTO poll_outcomes(id, poll_id, title, position) VALUES (?, ?, ?, ?)`,
          crypto.randomUUID(),
          id,
          title,
          position,
        );
      }
      this.event(id, input.creatorId, "created", input.now);
      return true;
    });
    if (!created) return { ok: false, code: "poll_limit" };
    return { ok: true, poll: this.poll(id, input.creatorId), affectedUserIds: [] };
  }

  bid(input: {
    pollId: string;
    outcomeId: string;
    userId: string;
    displayName: string;
    stake: number;
    now: number;
  }): PollMutationResult {
    if (!Number.isInteger(input.stake) || input.stake < 1) {
      return { ok: false, code: "bad_message" };
    }
    const result = this.storage.transactionSync<ErrorCode | null>(() => {
      const poll = this.row(input.pollId);
      if (poll === null) return "not_found";
      if (poll.status !== "open" || poll.closes_at <= input.now) return "poll_closed";
      const outcome = this.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM poll_outcomes WHERE id = ? AND poll_id = ?`,
          input.outcomeId,
          input.pollId,
        )
        .toArray()[0];
      if (outcome === undefined) return "bad_message";
      const existing = this.storage.sql
        .exec<{ user_id: string }>(
          `SELECT user_id FROM poll_bids WHERE poll_id = ? AND user_id = ?`,
          input.pollId,
          input.userId,
        )
        .toArray()[0];
      if (existing !== undefined) return "already_bid";
      this.points.settleUser(input.userId, input.now);
      if (!this.points.debitForPoll(input.userId, input.pollId, input.stake, input.now)) {
        return "insufficient_points";
      }
      this.storage.sql.exec(
        `INSERT INTO poll_bids(poll_id, user_id, display_name, outcome_id, stake, placed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.pollId,
        input.userId,
        input.displayName,
        input.outcomeId,
        input.stake,
        input.now,
      );
      this.event(input.pollId, input.userId, "bid", input.now, undefined, input.outcomeId);
      return null;
    });
    if (result !== null) return { ok: false, code: result };
    return {
      ok: true,
      poll: this.poll(input.pollId, input.userId),
      affectedUserIds: [input.userId],
    };
  }

  lock(pollId: string, actorId: string, isAdmin: boolean, now: number): PollMutationResult {
    const result = this.storage.transactionSync<ErrorCode | null>(() => {
      const poll = this.row(pollId);
      if (poll === null) return "not_found";
      if (!this.canManage(poll, actorId, isAdmin)) return "forbidden";
      if (poll.status !== "open") return "poll_closed";
      this.storage.sql.exec(
        `UPDATE polls SET status = 'locked', locked_at = ? WHERE id = ?`,
        now,
        pollId,
      );
      this.event(pollId, actorId, "locked", now);
      return null;
    });
    if (result !== null) return { ok: false, code: result };
    return { ok: true, poll: this.poll(pollId, actorId), affectedUserIds: [] };
  }

  resolve(
    pollId: string,
    outcomeId: string,
    actorId: string,
    isAdmin: boolean,
    now: number,
  ): PollMutationResult {
    const affected = new Set<string>();
    const result = this.storage.transactionSync<ErrorCode | null>(() => {
      const poll = this.row(pollId);
      if (poll === null) return "not_found";
      if (!this.canManage(poll, actorId, isAdmin)) return "forbidden";
      if (poll.status !== "locked") return "bad_message";
      if (!this.hasOutcome(pollId, outcomeId)) return "bad_message";
      for (const bid of this.bids(pollId)) affected.add(bid.user_id);
      this.allocatePayouts(pollId, outcomeId);
      this.storage.sql.exec(
        `UPDATE polls SET status = 'resolved_pending', resolved_at = ?, finalizes_at = ?,
           winning_outcome_id = ?, result_visible_until = ? WHERE id = ?`,
        now,
        now + LIMITS.pollCorrectionHoldMs,
        outcomeId,
        now + LIMITS.pollResultVisibleMs,
        pollId,
      );
      this.event(pollId, actorId, "resolved", now, undefined, outcomeId);
      return null;
    });
    if (result !== null) return { ok: false, code: result };
    return { ok: true, poll: this.poll(pollId, actorId), affectedUserIds: [...affected] };
  }

  correct(
    pollId: string,
    outcomeId: string,
    actorId: string,
    isAdmin: boolean,
    now: number,
  ): PollMutationResult {
    const affected = new Set<string>();
    const result = this.storage.transactionSync<ErrorCode | null>(() => {
      const poll = this.row(pollId);
      if (poll === null) return "not_found";
      if (!this.canManage(poll, actorId, isAdmin)) return "forbidden";
      if (
        poll.status !== "resolved_pending" ||
        poll.finalizes_at === null ||
        now >= poll.finalizes_at
      ) {
        return "correction_expired";
      }
      if (poll.correction_used !== 0) return "correction_used";
      if (!this.hasOutcome(pollId, outcomeId) || outcomeId === poll.winning_outcome_id) {
        return "bad_message";
      }
      for (const bid of this.bids(pollId)) affected.add(bid.user_id);
      this.allocatePayouts(pollId, outcomeId);
      this.storage.sql.exec(
        `UPDATE polls SET winning_outcome_id = ?, correction_used = 1,
           result_visible_until = ? WHERE id = ?`,
        outcomeId,
        now + LIMITS.pollResultVisibleMs,
        pollId,
      );
      this.event(
        pollId,
        actorId,
        "corrected",
        now,
        poll.winning_outcome_id ?? undefined,
        outcomeId,
      );
      return null;
    });
    if (result !== null) return { ok: false, code: result };
    return { ok: true, poll: this.poll(pollId, actorId), affectedUserIds: [...affected] };
  }

  void(pollId: string, actorId: string, isAdmin: boolean, now: number): PollMutationResult {
    const affected = new Set<string>();
    const result = this.storage.transactionSync<ErrorCode | null>(() => {
      const poll = this.row(pollId);
      if (poll === null) return "not_found";
      if (!this.canManage(poll, actorId, isAdmin)) return "forbidden";
      if (poll.status === "finalized" || poll.status === "voided") return "correction_expired";
      if (poll.status === "resolved_pending") {
        if (poll.finalizes_at === null || now >= poll.finalizes_at) return "correction_expired";
        if (poll.correction_used !== 0) return "correction_used";
      }
      this.voidInTransaction(poll, actorId, now, affected);
      return null;
    });
    if (result !== null) return { ok: false, code: result };
    return { ok: true, poll: this.poll(pollId, actorId), affectedUserIds: [...affected] };
  }

  processDue(now: number): PollDueResult {
    const changed = new Set<string>();
    const affected = new Set<string>();
    this.storage.transactionSync(() => {
      const open = this.storage.sql
        .exec<PollRow>(`SELECT * FROM polls WHERE status = 'open' AND closes_at <= ?`, now)
        .toArray();
      for (const poll of open) {
        this.storage.sql.exec(
          `UPDATE polls SET status = 'locked', locked_at = closes_at WHERE id = ?`,
          poll.id,
        );
        this.event(poll.id, undefined, "auto_locked", now);
        changed.add(poll.id);
      }
      const expiredLocked = this.storage.sql
        .exec<PollRow>(
          `SELECT * FROM polls WHERE status = 'locked' AND locked_at + ? <= ?`,
          LIMITS.pollResolveTimeoutMs,
          now,
        )
        .toArray();
      for (const poll of expiredLocked) {
        this.voidInTransaction(poll, undefined, now, affected, "auto_voided");
        changed.add(poll.id);
      }
      const finalizing = this.storage.sql
        .exec<PollRow>(
          `SELECT * FROM polls WHERE status = 'resolved_pending' AND finalizes_at <= ?`,
          now,
        )
        .toArray();
      for (const poll of finalizing) {
        for (const bid of this.bids(poll.id)) {
          affected.add(bid.user_id);
          this.points.creditPoll(bid.user_id, poll.id, "poll_payout", bid.payout, now);
        }
        this.storage.sql.exec(
          `UPDATE polls SET status = 'finalized', finalized_at = ? WHERE id = ?`,
          now,
          poll.id,
        );
        this.event(poll.id, undefined, "finalized", now);
        changed.add(poll.id);
      }
    });
    return {
      polls: [...changed].map((id) => this.poll(id, "00000000-0000-4000-8000-000000000000")),
      affectedUserIds: [...affected],
    };
  }

  nextDeadline(): number | null {
    const row = this.storage.sql
      .exec<{ due_at: number | null }>(
        `SELECT MIN(due_at) AS due_at FROM (
           SELECT closes_at AS due_at FROM polls WHERE status = 'open'
           UNION ALL
           SELECT locked_at + ? AS due_at FROM polls WHERE status = 'locked'
           UNION ALL
           SELECT finalizes_at AS due_at FROM polls WHERE status = 'resolved_pending'
         )`,
        LIMITS.pollResolveTimeoutMs,
      )
      .one();
    return row.due_at;
  }

  visible(userId: string, now: number): PollValue[] {
    return this.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM polls
         WHERE status IN ('open','locked')
            OR (status = 'resolved_pending' AND result_visible_until > ?)
         ORDER BY created_at ASC`,
        now,
      )
      .toArray()
      .map((row) => this.poll(row.id, userId));
  }

  page(userId: string, before: number | undefined, limit: number): PollPage {
    const take = Math.min(Math.max(1, limit), LIMITS.historyPageSize);
    const rows = this.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM polls WHERE (? IS NULL OR created_at < ?)
         ORDER BY created_at DESC LIMIT ?`,
        before ?? null,
        before ?? null,
        take + 1,
      )
      .toArray();
    const pageRows = rows.slice(0, take);
    return PollPage.parse({
      polls: pageRows.map((row) => this.detail(row.id, userId)),
      hasMore: rows.length > take,
    });
  }

  poll(id: string, userId: string): PollValue {
    const row = this.row(id);
    if (row === null) throw new Error(`poll missing: ${id}`);
    const outcomes = this.storage.sql
      .exec<OutcomeRow>(
        `SELECT o.id, o.title, COALESCE(SUM(b.stake), 0) AS total_points,
                COUNT(b.user_id) AS bidder_count
         FROM poll_outcomes o LEFT JOIN poll_bids b ON b.outcome_id = o.id
         WHERE o.poll_id = ? GROUP BY o.id, o.title, o.position ORDER BY o.position`,
        id,
      )
      .toArray();
    const myBid = this.storage.sql
      .exec<BidRow>(`SELECT * FROM poll_bids WHERE poll_id = ? AND user_id = ?`, id, userId)
      .toArray()[0];
    return Poll.parse({
      id: row.id,
      creatorId: row.creator_id,
      creatorDisplayName: row.creator_display_name,
      question: row.question,
      outcomes: outcomes.map((outcome) => ({
        id: outcome.id,
        title: outcome.title,
        totalPoints: outcome.total_points,
        bidderCount: outcome.bidder_count,
      })),
      status: row.status,
      createdAt: row.created_at,
      closesAt: row.closes_at,
      lockedAt: row.locked_at,
      resolvedAt: row.resolved_at,
      finalizesAt: row.finalizes_at,
      finalizedAt: row.finalized_at,
      voidedAt: row.voided_at,
      winningOutcomeId: row.winning_outcome_id,
      correctionUsed: row.correction_used !== 0,
      resultVisibleUntil: row.result_visible_until,
      totalPool: outcomes.reduce((sum, outcome) => sum + outcome.total_points, 0),
      myBid:
        myBid === undefined
          ? null
          : {
              outcomeId: myBid.outcome_id,
              stake: myBid.stake,
              payout: myBid.payout,
              placedAt: myBid.placed_at,
            },
    });
  }

  private detail(id: string, userId: string): PollDetail {
    const poll = this.poll(id, userId);
    return {
      ...poll,
      participants: this.bids(id).map((bid) => ({
        userId: bid.user_id,
        displayName: bid.display_name,
        outcomeId: bid.outcome_id,
        stake: bid.stake,
        payout: bid.payout,
        net: bid.payout - bid.stake,
        placedAt: bid.placed_at,
      })),
    };
  }

  private row(id: string): PollRow | null {
    return (
      this.storage.sql.exec<PollRow>(`SELECT * FROM polls WHERE id = ?`, id).toArray()[0] ?? null
    );
  }

  private bids(pollId: string): BidRow[] {
    return this.storage.sql
      .exec<BidRow>(`SELECT * FROM poll_bids WHERE poll_id = ? ORDER BY placed_at, user_id`, pollId)
      .toArray();
  }

  private hasOutcome(pollId: string, outcomeId: string): boolean {
    return (
      this.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM poll_outcomes WHERE poll_id = ? AND id = ?`,
          pollId,
          outcomeId,
        )
        .toArray()[0] !== undefined
    );
  }

  private canManage(poll: PollRow, actorId: string, isAdmin: boolean): boolean {
    return isAdmin || poll.creator_id === actorId;
  }

  private allocatePayouts(pollId: string, winningOutcomeId: string): void {
    const bids = this.bids(pollId);
    const pool = bids.reduce((sum, bid) => sum + bid.stake, 0);
    const winners = bids.filter((bid) => bid.outcome_id === winningOutcomeId);
    const winningStake = winners.reduce((sum, bid) => sum + bid.stake, 0);
    this.storage.sql.exec(`UPDATE poll_bids SET payout = 0 WHERE poll_id = ?`, pollId);
    if (pool === 0 || winningStake === 0) return;
    const allocated = winners.map((bid) => {
      const numerator = bid.stake * pool;
      return {
        bid,
        payout: Math.floor(numerator / winningStake),
        remainder: numerator % winningStake,
      };
    });
    let remaining = pool - allocated.reduce((sum, item) => sum + item.payout, 0);
    const priority = allocated.toSorted(
      (a, b) =>
        b.remainder - a.remainder ||
        a.bid.placed_at - b.bid.placed_at ||
        a.bid.user_id.localeCompare(b.bid.user_id),
    );
    for (const item of priority) {
      if (remaining === 0) break;
      item.payout += 1;
      remaining -= 1;
    }
    for (const item of allocated) {
      this.storage.sql.exec(
        `UPDATE poll_bids SET payout = ? WHERE poll_id = ? AND user_id = ?`,
        item.payout,
        pollId,
        item.bid.user_id,
      );
    }
  }

  private voidInTransaction(
    poll: PollRow,
    actorId: string | undefined,
    now: number,
    affected: Set<string>,
    action = "voided",
  ): void {
    for (const bid of this.bids(poll.id)) {
      affected.add(bid.user_id);
      this.points.creditPoll(bid.user_id, poll.id, "poll_refund", bid.stake, now);
    }
    this.storage.sql.exec(
      `UPDATE polls SET status = 'voided', voided_at = ?, correction_used = CASE
         WHEN status = 'resolved_pending' THEN 1 ELSE correction_used END,
         result_visible_until = NULL WHERE id = ?`,
      now,
      poll.id,
    );
    this.storage.sql.exec(`UPDATE poll_bids SET payout = 0 WHERE poll_id = ?`, poll.id);
    this.event(poll.id, actorId, action, now);
  }

  private event(
    pollId: string,
    actorId: string | undefined,
    action: string,
    at: number,
    fromOutcomeId?: string,
    toOutcomeId?: string,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO poll_events(poll_id, actor_id, action, from_outcome_id, to_outcome_id, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      pollId,
      actorId ?? null,
      action,
      fromOutcomeId ?? null,
      toOutcomeId ?? null,
      at,
    );
  }
}
