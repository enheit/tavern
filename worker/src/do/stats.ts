import { StatsResponse } from "@tavern/shared";
import type { Member } from "@tavern/shared";

// Open (in-progress) stream/watch intervals, persisted in ctx.storage KV under `stats:open` so an
// eviction/hibernation cannot lose the running clocks (§S3.4 task 4). Watch keys are `viewerId:streamerId`
// (userIds are UUIDs — they never contain a colon, so the split back is unambiguous).
type OpenIntervals = {
  streams: Record<string, number>;
  watches: Record<string, number>;
};

const OPEN_KEY = "stats:open";

function watchKey(viewerId: string, streamerId: string): string {
  return `${viewerId}:${streamerId}`;
}

// Whole seconds elapsed between two epoch-ms marks, clamped at 0 (never negative — idempotency guard).
function elapsedSeconds(startMs: number, endMs: number): number {
  return Math.floor(Math.max(0, endMs - startMs) / 1000);
}

// Accumulates server-authoritative watch/stream seconds (FR-40). All timing is explicit (`at`/`now`
// passed in — no internal clock, for testability). Open intervals live in KV; the accumulated totals
// live in the `stat_stream_seconds` / `stat_watch_seconds` SQLite tables (S3.1 migration, no schema
// change). Every accumulation re-baselines the open interval to `now`, so a running interval survives
// any number of alarm flushes plus its final stop with no double-count.
export class StatsModule {
  constructor(private readonly ctx: DurableObjectState) {}

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private async readOpen(): Promise<OpenIntervals> {
    const stored = await this.ctx.storage.get<OpenIntervals>(OPEN_KEY);
    if (stored === undefined) return { streams: {}, watches: {} };
    return { streams: { ...stored.streams }, watches: { ...stored.watches } };
  }

  private async writeOpen(open: OpenIntervals): Promise<void> {
    await this.ctx.storage.put(OPEN_KEY, open);
  }

  // Opens a stream interval; a duplicate start keeps the earlier clock (never resets an in-flight one).
  async noteStreamStart(userId: string, at: number): Promise<void> {
    const open = await this.readOpen();
    if (userId in open.streams) return;
    open.streams[userId] = at;
    await this.writeOpen(open);
  }

  // Closes a stream interval, accruing its final segment. A stop with no open interval is a no-op.
  async noteStreamStop(userId: string, at: number): Promise<void> {
    const open = await this.readOpen();
    const start = open.streams[userId];
    if (start === undefined) return;
    this.addStreamSeconds(userId, elapsedSeconds(start, at));
    delete open.streams[userId];
    await this.writeOpen(open);
  }

  async noteWatchStart(viewerId: string, streamerId: string, at: number): Promise<void> {
    const open = await this.readOpen();
    const key = watchKey(viewerId, streamerId);
    if (key in open.watches) return;
    open.watches[key] = at;
    await this.writeOpen(open);
  }

  async noteWatchStop(viewerId: string, streamerId: string, at: number): Promise<void> {
    const open = await this.readOpen();
    const key = watchKey(viewerId, streamerId);
    const start = open.watches[key];
    if (start === undefined) return;
    this.addWatchSeconds(viewerId, streamerId, elapsedSeconds(start, at));
    delete open.watches[key];
    await this.writeOpen(open);
  }

  // Leave/disconnect sweep (§S3.4 task 3): closes every interval that involves the user — their own
  // stream, their watches (as viewer), and any watch OF their stream (as streamer, since it ended).
  async closeAllFor(userId: string, at: number): Promise<void> {
    const open = await this.readOpen();
    let changed = false;
    const streamStart = open.streams[userId];
    if (streamStart !== undefined) {
      this.addStreamSeconds(userId, elapsedSeconds(streamStart, at));
      delete open.streams[userId];
      changed = true;
    }
    for (const key of Object.keys(open.watches)) {
      const [viewerId, streamerId] = key.split(":");
      if (viewerId === undefined || streamerId === undefined) continue;
      if (viewerId !== userId && streamerId !== userId) continue;
      const start = open.watches[key];
      if (start !== undefined)
        this.addWatchSeconds(viewerId, streamerId, elapsedSeconds(start, at));
      delete open.watches[key];
      changed = true;
    }
    if (changed) await this.writeOpen(open);
  }

  // Mid-session accrual (called from the alarm while voice still has members): banks each open
  // interval's segment so far and re-baselines its clock to `now`. A no-op when nothing is open.
  async flushOpenIntervals(now: number): Promise<void> {
    const open = await this.readOpen();
    let changed = false;
    for (const userId of Object.keys(open.streams)) {
      const start = open.streams[userId];
      if (start === undefined) continue;
      this.addStreamSeconds(userId, elapsedSeconds(start, now));
      open.streams[userId] = now;
      changed = true;
    }
    for (const key of Object.keys(open.watches)) {
      const start = open.watches[key];
      if (start === undefined) continue;
      const [viewerId, streamerId] = key.split(":");
      if (viewerId === undefined || streamerId === undefined) continue;
      this.addWatchSeconds(viewerId, streamerId, elapsedSeconds(start, now));
      open.watches[key] = now;
      changed = true;
    }
    if (changed) await this.writeOpen(open);
  }

  // Whether any stream/watch interval is currently open — gates the alarm's re-arm decision (task 5c).
  async hasOpenIntervals(): Promise<boolean> {
    const open = await this.readOpen();
    return Object.keys(open.streams).length > 0 || Object.keys(open.watches).length > 0;
  }

  // Server-authoritative stats snapshot (FR-40). `perUser` is the union of the member cache, the
  // message senders, and the stream-seconds rows; `watchPairs` is every accumulated (viewer→streamer)
  // pair. Synchronous — the totals live in SQLite (sync), open intervals are not read here.
  snapshot(messageCounts: Map<string, number>, members: Member[]): StatsResponse {
    const streamSeconds = new Map<string, number>();
    for (const row of this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT user_id, seconds FROM stat_stream_seconds`)
      .toArray()) {
      streamSeconds.set(String(row["user_id"]), Number(row["seconds"]));
    }
    const userIds = new Set<string>();
    for (const member of members) userIds.add(member.userId);
    for (const userId of streamSeconds.keys()) userIds.add(userId);
    for (const userId of messageCounts.keys()) userIds.add(userId);
    const perUser = [...userIds].map((userId) => ({
      userId,
      messages: messageCounts.get(userId) ?? 0,
      streamSeconds: streamSeconds.get(userId) ?? 0,
    }));
    const watchPairs = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT viewer_id, streamer_id, seconds FROM stat_watch_seconds`,
      )
      .toArray()
      .map((row) => ({
        viewerId: String(row["viewer_id"]),
        streamerId: String(row["streamer_id"]),
        seconds: Number(row["seconds"]),
      }));
    // Validate the DO→wire boundary (§9.8 / A9) before it leaves the DO as an HTTP body.
    return StatsResponse.parse({ perUser, watchPairs });
  }

  private addStreamSeconds(userId: string, seconds: number): void {
    if (seconds <= 0) return;
    this.sql.exec(
      `INSERT INTO stat_stream_seconds (user_id, seconds) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET seconds = seconds + excluded.seconds`,
      userId,
      seconds,
    );
  }

  private addWatchSeconds(viewerId: string, streamerId: string, seconds: number): void {
    if (seconds <= 0) return;
    this.sql.exec(
      `INSERT INTO stat_watch_seconds (viewer_id, streamer_id, seconds) VALUES (?, ?, ?)
       ON CONFLICT(viewer_id, streamer_id) DO UPDATE SET seconds = seconds + excluded.seconds`,
      viewerId,
      streamerId,
      seconds,
    );
  }
}
