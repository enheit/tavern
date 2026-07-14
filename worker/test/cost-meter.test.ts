import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CostMeter } from "../src/do/costMeter";
import { RoomState } from "../src/do/roomState";

type RoomStub = DurableObjectStub<import("../src/do/ServerRoom").ServerRoom>;

let roomSeq = 0;
function freshRoom(): RoomStub {
  roomSeq += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`cost-${Date.now()}-${roomSeq}`));
}

// UTC month bucket, mirroring costMeter.ts's private monthOf (egress_log PRIMARY KEY).
function monthOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sumEgress(state: DurableObjectState): number {
  const row = state.storage.sql
    .exec<{ total: number | null }>(`SELECT SUM(bytes) AS total FROM egress_log`)
    .one();
  return Number(row.total ?? 0);
}

const GB = 1_000_000_000;
const T0 = 1_700_000_000_000; // fixed epoch-ms so month bucketing is deterministic

describe("§8 G5 cost meter", () => {
  it("h-layer 1080p30 watched 600s = 262,500,000 bytes (3500 kbps × 1000/8 × 600)", async () => {
    const viewer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      await meter.openWatch(viewer, "screen:pub:1", "1080p30", "h", T0);
      await meter.closeWatch(viewer, "screen:pub:1", T0 + 600_000);
      expect(sumEgress(state)).toBe(262_500_000);
    });
  });

  it("480p15 l-layer watched 3600s = 45,000,000 bytes (100 kbps × 1000/8 × 3600)", async () => {
    const viewer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      await meter.openWatch(viewer, "screen:pub:1", "480p15", "l", T0);
      await meter.closeWatch(viewer, "screen:pub:1", T0 + 3_600_000);
      expect(sumEgress(state)).toBe(45_000_000);
    });
  });

  it("rid switch mid-watch splits accounting at the switch time", async () => {
    const viewer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      await meter.openWatch(viewer, "screen:pub:1", "1080p30", "h", T0);
      await meter.setWatcherLayer(viewer, "screen:pub:1", "l", T0 + 300_000); // 300s at h
      await meter.closeWatch(viewer, "screen:pub:1", T0 + 600_000); // 300s at l
      // h: 3500*1000/8*300 = 131,250,000 ; l: 350*1000/8*300 = 13,125,000
      expect(sumEgress(state)).toBe(144_375_000);
    });
  });

  it("audio-only saver intervals keep the watch open but add zero video egress", async () => {
    const viewer = crypto.randomUUID();
    const trackName = "screen:pub:1";
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      await meter.openWatch(viewer, trackName, "1080p30", "h", T0);
      await meter.setWatcherDelivery(viewer, trackName, "audio", T0 + 100_000);
      await meter.setWatcherDelivery(viewer, trackName, "video", T0 + 300_000);
      await meter.closeWatch(viewer, trackName, T0 + 400_000);

      // 100s video + 200s audio-only + 100s video = 200s charged at 3500 kbps.
      expect(sumEgress(state)).toBe(87_500_000);
    });
  });

  it("crossing 700 GB flags cost.warning once per month-bucket (meter-state idempotent, no WS)", async () => {
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      state.storage.sql.exec(
        `INSERT INTO egress_log (month, bytes) VALUES (?, ?)`,
        monthOf(T0),
        700 * GB,
      );
      expect(await meter.maybeWarn(T0)).toBe(true);
      expect(await meter.maybeWarn(T0)).toBe(false); // idempotent within the month
    });
  });

  it("kill at 900 GB → non-mic pull returns cost_cap; mic pull still allowed", async () => {
    const viewer = crypto.randomUUID();
    const publisher = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const room = new RoomState(state, env);
      const meter = new CostMeter(state, {});
      state.storage.sql.exec(
        `INSERT INTO egress_log (month, bytes) VALUES (?, ?)`,
        monthOf(T0),
        900 * GB,
      );
      await state.storage.put("voice", {
        members: [{ userId: viewer, muted: false, deafened: false }],
        sessionStartedAt: T0,
      });
      const screen = `screen:${publisher}:1`;
      const mic = `mic:${publisher}`;
      await state.storage.put("rtc", {
        sessions: { s1: publisher },
        tracks: {
          [screen]: { userId: publisher, sessionId: "s1", kind: "screen", preset: "1080p30" },
          [mic]: { userId: publisher, sessionId: "s1", kind: "mic" },
        },
        grants: { [viewer]: { [screen]: "h" } },
      });

      const screenRes = await room.rtcAuthorize(
        { op: "pull", userId: viewer, tracks: [{ trackName: screen }] },
        meter,
        T0,
      );
      expect(screenRes).toEqual({ ok: false, error: "cost_cap" });

      const micRes = await room.rtcAuthorize(
        { op: "pull", userId: viewer, tracks: [{ trackName: mic }] },
        meter,
        T0,
      );
      expect(micRes.ok).toBe(true);
    });
  });

  it("KILL_SWITCH_DISABLED=1 bypasses the kill, but the meter still increments", async () => {
    const viewer = crypto.randomUUID();
    const publisher = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const room = new RoomState(state, env);
      const meter = new CostMeter(state, { KILL_SWITCH_DISABLED: "1" });
      state.storage.sql.exec(
        `INSERT INTO egress_log (month, bytes) VALUES (?, ?)`,
        monthOf(T0),
        900 * GB,
      );
      await state.storage.put("voice", {
        members: [{ userId: viewer, muted: false, deafened: false }],
        sessionStartedAt: T0,
      });
      const screen = `screen:${publisher}:1`;
      await state.storage.put("rtc", {
        sessions: { s1: publisher },
        tracks: {
          [screen]: { userId: publisher, sessionId: "s1", kind: "screen", preset: "1080p30" },
        },
        grants: { [viewer]: { [screen]: "h" } },
      });

      // Kill bypassed → the pull is authorized even past the cap.
      const res = await room.rtcAuthorize(
        { op: "pull", userId: viewer, tracks: [{ trackName: screen }] },
        meter,
        T0,
      );
      expect(res.ok).toBe(true);

      // ...but the meter itself keeps counting.
      const before = sumEgress(state);
      await meter.openWatch(viewer, screen, "1080p30", "h", T0);
      await meter.closeWatch(viewer, screen, T0 + 10_000);
      expect(sumEgress(state)).toBeGreaterThan(before);
    });
  });

  it("tick projects an open watch without writing its running segment", async () => {
    const viewer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      await meter.openWatch(viewer, "screen:pub:1", "1080p30", "h", T0);
      const warned = await meter.tick(T0 + 60_000);
      expect(warned).toBe(false);
      expect(sumEgress(state)).toBe(0);
      // 3500 kbps × 1000/8 × 60 = 26,250,000 projected bytes.
      expect(await meter.usedGB(T0 + 60_000)).toBe(0.02625);
    });
  });

  it("the alarm flushes open watches into egress_log (via runDurableObjectAlarm)", async () => {
    const stub = freshRoom();
    const member = crypto.randomUUID();
    const since = Date.now() - 120_000;

    await runInDurableObject(stub, async (_i, state) => {
      // A voice member with a running watch. In the default project the member has no live socket, so
      // the alarm reconciles it (ghost) and its open watch is flushed on the disconnect sweep — either
      // way runDurableObjectAlarm banks the running segment into egress_log.
      await state.storage.put("voice", {
        members: [{ userId: member, muted: false, deafened: false }],
        sessionStartedAt: since,
      });
      await state.storage.put("cost:open", {
        [`${member}|screen:pub:1`]: { preset: "1080p30", rid: "h", since },
      });
      await state.storage.put("voice:disconnects", { [member]: 0 });
      await state.storage.setAlarm(Date.now() + 3_600_000); // future → only the explicit fire triggers
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_i, state) => {
      expect(sumEgress(state)).toBeGreaterThan(0);
    });
  });
});
