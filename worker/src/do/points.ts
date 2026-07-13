import {
  PointConfig,
  PointSnapshot,
  type PointSource,
  type PointSnapshot as PointSnapshotValue,
} from "@tavern/shared";

export type PointEligibility = Record<PointSource, readonly string[]>;

const POINT_SOURCES = ["conversation", "streaming", "watching"] as const;
const MILLIS_PER_MINUTE = 60_000;

type ConfigRow = {
  enabled: number;
  base_points_per_minute: number;
  streamer_bonus_per_minute: number;
  watcher_bonus_per_minute: number;
  daily_cap: number | null;
};

type SourceRow = {
  user_id: string;
  source: PointSource;
  started_at: number;
  remainder: number;
};

type DailyRow = {
  conversation: number;
  streaming: number;
  watching: number;
};

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function nextUtcDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function sourceColumn(source: PointSource): PointSource {
  return source;
}

export class PointsModule {
  constructor(private readonly sql: SqlStorage) {}

  config(): PointConfig {
    const row = this.sql
      .exec<ConfigRow>(
        `SELECT enabled, base_points_per_minute, streamer_bonus_per_minute,
                watcher_bonus_per_minute, daily_cap
         FROM point_config WHERE id = 1`,
      )
      .one();
    return PointConfig.parse({
      enabled: row.enabled !== 0,
      basePointsPerMinute: row.base_points_per_minute,
      streamerBonusPerMinute: row.streamer_bonus_per_minute,
      watcherBonusPerMinute: row.watcher_bonus_per_minute,
      dailyCap: row.daily_cap,
    });
  }

  updateConfig(config: PointConfig, updatedBy: string, now: number): void {
    this.settle(now);
    this.sql.exec(
      `UPDATE point_config
       SET enabled = ?, base_points_per_minute = ?, streamer_bonus_per_minute = ?,
           watcher_bonus_per_minute = ?, daily_cap = ?, updated_at = ?, updated_by = ?
       WHERE id = 1`,
      config.enabled ? 1 : 0,
      config.basePointsPerMinute,
      config.streamerBonusPerMinute,
      config.watcherBonusPerMinute,
      config.dailyCap,
      now,
      updatedBy,
    );
  }

  replaceSources(eligibility: PointEligibility, now: number): void {
    this.settle(now);
    this.sql.exec(`UPDATE point_sources SET active = 0, started_at = NULL WHERE active = 1`);
    for (const source of POINT_SOURCES) {
      for (const userId of new Set(eligibility[source])) {
        this.sql.exec(
          `INSERT INTO point_sources(user_id, source, active, started_at, remainder)
           VALUES (?, ?, 1, ?, 0)
           ON CONFLICT(user_id, source) DO UPDATE SET active = 1, started_at = excluded.started_at`,
          userId,
          source,
          now,
        );
      }
    }
  }

  settle(now: number): void {
    const config = this.config();
    const rows = this.sql
      .exec<SourceRow>(
        `SELECT user_id, source, started_at, remainder
         FROM point_sources WHERE active = 1 AND started_at IS NOT NULL
         ORDER BY user_id, source`,
      )
      .toArray();
    for (const row of rows) {
      const start = Math.min(row.started_at, now);
      const remainder = this.settleSource(
        row.user_id,
        row.source,
        start,
        now,
        row.remainder,
        config,
      );
      this.sql.exec(
        `UPDATE point_sources SET started_at = ?, remainder = ? WHERE user_id = ? AND source = ?`,
        now,
        remainder,
        row.user_id,
        row.source,
      );
    }
  }

  snapshot(userId: string, now: number): PointSnapshotValue {
    const config = this.config();
    const balance =
      this.sql
        .exec<{ balance: number }>(`SELECT balance FROM point_accounts WHERE user_id = ?`, userId)
        .toArray()[0]?.balance ?? 0;
    const today = dayKey(now);
    const daily = this.daily(userId, today);
    const activeSources = this.sql
      .exec<{ source: PointSource }>(
        `SELECT source FROM point_sources
         WHERE user_id = ? AND active = 1 ORDER BY source`,
        userId,
      )
      .toArray()
      .map((row) => row.source);
    const currentRatePerMinute = config.enabled
      ? activeSources.reduce((sum, source) => sum + this.rateFor(source, config), 0)
      : 0;
    return PointSnapshot.parse({
      balance,
      pendingPollWinnings: this.pendingPollWinnings(userId),
      currentRatePerMinute,
      activeSources,
      today: {
        day: today,
        ...daily,
        total: daily.conversation + daily.streaming + daily.watching,
      },
      config,
    });
  }

  debitForPoll(userId: string, pollId: string, amount: number, now: number): boolean {
    this.sql.exec(
      `INSERT OR IGNORE INTO point_accounts(user_id, balance, updated_at) VALUES (?, 0, ?)`,
      userId,
      now,
    );
    const changed = this.sql
      .exec<{ balance: number }>(
        `UPDATE point_accounts SET balance = balance - ?, updated_at = ?
         WHERE user_id = ? AND balance >= ? RETURNING balance`,
        amount,
        now,
        userId,
        amount,
      )
      .toArray();
    if (changed.length === 0) return false;
    this.sql.exec(
      `INSERT INTO point_transactions(tx_key, user_id, poll_id, kind, delta, created_at)
       VALUES (?, ?, ?, 'poll_stake', ?, ?)`,
      `poll:${pollId}:stake:${userId}`,
      userId,
      pollId,
      -amount,
      now,
    );
    return true;
  }

  creditPoll(
    userId: string,
    pollId: string,
    kind: "poll_refund" | "poll_payout",
    amount: number,
    now: number,
  ): void {
    if (amount <= 0) return;
    const txKey = `poll:${pollId}:${kind}:${userId}`;
    const inserted = this.sql
      .exec<{ tx_key: string }>(
        `INSERT OR IGNORE INTO point_transactions(tx_key, user_id, poll_id, kind, delta, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING tx_key`,
        txKey,
        userId,
        pollId,
        kind,
        amount,
        now,
      )
      .toArray();
    if (inserted.length === 0) return;
    this.sql.exec(
      `INSERT INTO point_accounts(user_id, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         balance = balance + excluded.balance, updated_at = excluded.updated_at`,
      userId,
      amount,
      now,
    );
  }

  setBalanceForTest(userId: string, balance: number, now: number): void {
    this.sql.exec(
      `INSERT INTO point_accounts(user_id, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at`,
      userId,
      balance,
      now,
    );
  }

  leaderboard(userIds: readonly string[], now: number): Array<{ userId: string; balance: number }> {
    this.settle(now);
    const balances = new Map(
      this.sql
        .exec<{ user_id: string; balance: number }>(
          `SELECT user_id, balance FROM point_accounts ORDER BY user_id`,
        )
        .toArray()
        .map((row) => [row.user_id, row.balance]),
    );
    return [...new Set(userIds)]
      .map((userId) => ({ userId, balance: balances.get(userId) ?? 0 }))
      .toSorted((a, b) => b.balance - a.balance || a.userId.localeCompare(b.userId));
  }

  private settleSource(
    userId: string,
    source: PointSource,
    start: number,
    now: number,
    initialRemainder: number,
    config: PointConfig,
  ): number {
    const rate = config.enabled ? this.rateFor(source, config) : 0;
    if (rate === 0 || now <= start) return initialRemainder;
    let cursor = start;
    let remainder = initialRemainder;
    while (cursor < now) {
      const segmentEnd = Math.min(now, nextUtcDay(cursor));
      const numerator = remainder + (segmentEnd - cursor) * rate;
      const points = Math.floor(numerator / MILLIS_PER_MINUTE);
      remainder = numerator % MILLIS_PER_MINUTE;
      if (points > 0) this.credit(userId, source, dayKey(cursor), points, config.dailyCap, now);
      cursor = segmentEnd;
    }
    return remainder;
  }

  private credit(
    userId: string,
    source: PointSource,
    day: string,
    points: number,
    dailyCap: number | null,
    now: number,
  ): void {
    const daily = this.daily(userId, day);
    const earned = daily.conversation + daily.streaming + daily.watching;
    const allowed = dailyCap === null ? points : Math.max(0, Math.min(points, dailyCap - earned));
    if (allowed === 0) return;
    const column = sourceColumn(source);
    this.sql.exec(
      `INSERT INTO point_accounts(user_id, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         balance = balance + excluded.balance, updated_at = excluded.updated_at`,
      userId,
      allowed,
      now,
    );
    this.sql.exec(
      `INSERT INTO point_daily(user_id, day, ${column}) VALUES (?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
      userId,
      day,
      allowed,
    );
  }

  private daily(userId: string, day: string): DailyRow {
    return (
      this.sql
        .exec<DailyRow>(
          `SELECT conversation, streaming, watching FROM point_daily
           WHERE user_id = ? AND day = ?`,
          userId,
          day,
        )
        .toArray()[0] ?? { conversation: 0, streaming: 0, watching: 0 }
    );
  }

  private pendingPollWinnings(userId: string): number {
    return this.sql
      .exec<{ total: number }>(
        `SELECT COALESCE(SUM(b.payout), 0) AS total
         FROM poll_bids b JOIN polls p ON p.id = b.poll_id
         WHERE b.user_id = ? AND p.status = 'resolved_pending'`,
        userId,
      )
      .one().total;
  }

  private rateFor(source: PointSource, config: PointConfig): number {
    if (source === "conversation") return config.basePointsPerMinute;
    if (source === "streaming") return config.streamerBonusPerMinute;
    return config.watcherBonusPerMinute;
  }
}
