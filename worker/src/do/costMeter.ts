import { CostStatus, LIMITS, kbpsFor } from "@tavern/shared";
import type { CostStatus as CostStatusType, PresetId } from "@tavern/shared";

// §8 G5 egress meter + kill switch (day-one requirement, not polish). The DO accumulates ESTIMATED
// egress = Σ active pulls × §App-D bitrate × dt, banked on watch release / rid-switch and on the S3.4
// 60s alarm tick, into `egress_log(month)`. At egressWarnGB → cost.warning (once per month-bucket);
// at egressKillGB → new non-mic pulls are rejected (cost_cap); voice always flows. KILL_SWITCH_DISABLED
// bypasses the kill only — the meter keeps counting so the group still sees the number.
//
// Units are DECIMAL (pinned §6.1 task 6): 1 GB = 10^9 bytes; bytes = kbps × 1000 / 8 × dtSeconds.

const OPEN_KEY = "cost:open";
const WARNED_KEY = "cost:warnedMonth";
const BYTES_PER_GB = 1_000_000_000;

// One open watch = one active pull being metered. Keyed by `${viewerId}|${trackName}` (viewerId is a
// UUID and trackName is a colon-grammar name — neither contains '|', so the join is unambiguous).
type OpenWatch = { preset: PresetId; rid: "h" | "l"; since: number };
type OpenWatches = Record<string, OpenWatch>;

export type CostMeterEnv = { KILL_SWITCH_DISABLED?: string };

// KILL_SWITCH_DISABLED is an emergency env var (not a deployed binding, so absent from generated Env).
declare global {
  interface Env {
    KILL_SWITCH_DISABLED?: string;
  }
}

function watchKey(viewerId: string, trackName: string): string {
  return `${viewerId}|${trackName}`;
}

// bytes for one metered segment (App-D bitrate × dt). kbps×1000/8 = bytes/s; ×(dtMs/1000) = bytes.
function segmentBytes(preset: PresetId, rid: "h" | "l", sinceMs: number, nowMs: number): number {
  const dtSeconds = Math.max(0, nowMs - sinceMs) / 1000;
  return Math.round(((kbpsFor(preset, rid) * 1000) / 8) * dtSeconds);
}

// UTC month bucket 'YYYY-MM' (egress_log PRIMARY KEY).
function monthOf(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class CostMeter {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: CostMeterEnv,
  ) {}

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private async readOpen(): Promise<OpenWatches> {
    const stored = await this.ctx.storage.get<OpenWatches>(OPEN_KEY);
    return stored === undefined ? {} : { ...stored };
  }

  private async writeOpen(open: OpenWatches): Promise<void> {
    await this.ctx.storage.put(OPEN_KEY, open);
  }

  private addBytes(month: string, bytes: number): void {
    if (bytes <= 0) return;
    this.sql.exec(
      `INSERT INTO egress_log (month, bytes) VALUES (?, ?)
       ON CONFLICT(month) DO UPDATE SET bytes = bytes + excluded.bytes`,
      month,
      bytes,
    );
  }

  private bytesForMonth(month: string): number {
    const row = this.sql
      .exec<{ bytes: number }>(`SELECT bytes FROM egress_log WHERE month = ?`, month)
      .toArray()[0];
    return row === undefined ? 0 : Number(row.bytes);
  }

  // Opens a metered pull (called at grant/watch.start, S8.2). A duplicate keeps the earlier clock.
  async openWatch(
    viewerId: string,
    trackName: string,
    preset: PresetId,
    rid: "h" | "l",
    since: number,
  ): Promise<void> {
    const open = await this.readOpen();
    const key = watchKey(viewerId, trackName);
    if (key in open) return;
    open[key] = { preset, rid, since };
    await this.writeOpen(open);
  }

  // op:'layer' reprice (FR-33): bank the segment at the OLD rid up to `at`, then re-baseline at the new
  // rid so the meter charges the correct bitrate from the switch point onward. `at` is injected (S3.4
  // pin) even though the pinned S8.4 signature omits it — the whole meter API takes an explicit clock.
  async setWatcherLayer(
    viewerId: string,
    trackName: string,
    rid: "h" | "l",
    at: number,
  ): Promise<void> {
    const open = await this.readOpen();
    const key = watchKey(viewerId, trackName);
    const entry = open[key];
    if (entry === undefined) return;
    this.addBytes(monthOf(entry.since), segmentBytes(entry.preset, entry.rid, entry.since, at));
    open[key] = { preset: entry.preset, rid, since: at };
    await this.writeOpen(open);
  }

  // FR-27 publisher preset switch: reprice EVERY open watch of this stream — bank each segment at the
  // OLD preset up to `at`, then re-baseline at the new preset (rid unchanged). Keeps the meter (G5)
  // accurate after a live switch; a watcher that STARTS after the switch reads the new preset from the
  // registry (roomState.rtcRepriceStream), so the two stay consistent. `at` injected (S3.4 pin).
  async repriceStream(trackName: string, preset: PresetId, at: number): Promise<void> {
    const open = await this.readOpen();
    let changed = false;
    for (const key of Object.keys(open)) {
      // key = `${viewerId}|${trackName}`; viewerId is a UUID (no '|'), so split on the FIRST '|'.
      const sep = key.indexOf("|");
      if (sep < 0 || key.slice(sep + 1) !== trackName) continue;
      const entry = open[key];
      if (entry === undefined) continue;
      this.addBytes(monthOf(entry.since), segmentBytes(entry.preset, entry.rid, entry.since, at));
      open[key] = { preset, rid: entry.rid, since: at };
      changed = true;
    }
    if (changed) await this.writeOpen(open);
  }

  // Closes a metered pull (watch.stop / release): bank the final segment + drop the entry.
  async closeWatch(viewerId: string, trackName: string, at: number): Promise<void> {
    const open = await this.readOpen();
    const key = watchKey(viewerId, trackName);
    const entry = open[key];
    if (entry === undefined) return;
    this.addBytes(monthOf(entry.since), segmentBytes(entry.preset, entry.rid, entry.since, at));
    delete open[key];
    await this.writeOpen(open);
  }

  // Disconnect cleanup: close every watch the user is the VIEWER of (their pulls ended when they left).
  async closeWatchesForViewer(viewerId: string, at: number): Promise<void> {
    const open = await this.readOpen();
    const prefix = `${viewerId}|`;
    let changed = false;
    for (const key of Object.keys(open)) {
      if (!key.startsWith(prefix)) continue;
      const entry = open[key];
      if (entry !== undefined) {
        this.addBytes(monthOf(entry.since), segmentBytes(entry.preset, entry.rid, entry.since, at));
      }
      delete open[key];
      changed = true;
    }
    if (changed) await this.writeOpen(open);
  }

  // Mid-session flush (alarm tick): bank each open watch's segment so far + re-baseline its clock to
  // `now`, so a running pull survives any number of ticks plus its final close with no double-count.
  async flush(now: number): Promise<void> {
    const open = await this.readOpen();
    let changed = false;
    for (const key of Object.keys(open)) {
      const entry = open[key];
      if (entry === undefined) continue;
      this.addBytes(monthOf(entry.since), segmentBytes(entry.preset, entry.rid, entry.since, now));
      open[key] = { preset: entry.preset, rid: entry.rid, since: now };
      changed = true;
    }
    if (changed) await this.writeOpen(open);
  }

  usedGB(now: number): number {
    return this.bytesForMonth(monthOf(now)) / BYTES_PER_GB;
  }

  // Kill switch: block non-mic pulls once egress ≥ killGB. KILL_SWITCH_DISABLED=1 bypasses the block
  // (the meter itself keeps counting regardless — this only gates the pull decision).
  isBlocked(now: number): boolean {
    if (this.env.KILL_SWITCH_DISABLED === "1") return false;
    return this.usedGB(now) >= LIMITS.egressKillGB;
  }

  // Emits true the FIRST time usage reaches warnGB in a given month-bucket, then false (idempotent via
  // the persisted warned-month marker) — "cost.warning once per month" (§8 G5).
  async maybeWarn(now: number): Promise<boolean> {
    if (this.usedGB(now) < LIMITS.egressWarnGB) return false;
    const month = monthOf(now);
    if ((await this.ctx.storage.get<string>(WARNED_KEY)) === month) return false;
    await this.ctx.storage.put(WARNED_KEY, month);
    return true;
  }

  // Alarm-tick seam (§S3.4 alarm): flush open watches, then report whether the warn threshold was newly
  // crossed this month — ServerRoom broadcasts cost.warning iff true.
  async tick(now: number): Promise<boolean> {
    await this.flush(now);
    return this.maybeWarn(now);
  }

  // Synchronous snapshot for hello.ok.costStatus (egress_log is sync SQL; no open-watch read needed).
  status(now: number): CostStatusType {
    return CostStatus.parse({
      usedGB: this.usedGB(now),
      capGB: LIMITS.egressKillGB,
      blocked: this.isBlocked(now),
    });
  }
}
