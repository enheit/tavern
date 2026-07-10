import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CostMeter } from "../../src/do/costMeter";

// FR-27 on-the-fly preset switch, meter side (§8 G5 / §App-D). Pure meter math with an INJECTED clock
// (S3.4 pin — never `sleep`): exact byte counts for a 60 s window at a given preset/layer, and the
// mid-interval reprice split. Units are decimal: bytes = kbps × 1000 / 8 × dtSeconds.
type RoomStub = DurableObjectStub<import("../../src/do/ServerRoom").ServerRoom>;

let roomSeq = 0;
function freshRoom(): RoomStub {
  roomSeq += 1;
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(`preset-meter-${Date.now()}-${roomSeq}`));
}

function sumEgress(state: DurableObjectState): number {
  const row = state.storage.sql
    .exec<{ total: number | null }>(`SELECT SUM(bytes) AS total FROM egress_log`)
    .one();
  return Number(row.total ?? 0);
}

const T0 = 1_700_000_000_000; // fixed epoch-ms so month bucketing is deterministic
const MINUTE = 60_000;
const TRACK = "screen:pub:1";

describe("FR-27 preset repricing", () => {
  it("720p30 watcher on h meters 9,000,000 bytes per 60s tick (1200 kbps)", async () => {
    const viewer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      await meter.openWatch(viewer, TRACK, "720p30", "h", T0);
      await meter.closeWatch(viewer, TRACK, T0 + MINUTE);
      // 1200 * 1000 / 8 * 60 = 9,000,000
      expect(sumEgress(state)).toBe(9_000_000);
    });
  });

  it("the same watcher on l meters 1,875,000 bytes per 60s (250 kbps)", async () => {
    const viewer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      await meter.openWatch(viewer, TRACK, "720p30", "l", T0);
      await meter.closeWatch(viewer, TRACK, T0 + MINUTE);
      // 250 * 1000 / 8 * 60 = 1,875,000 (the l-rate is fixed regardless of the preset)
      expect(sumEgress(state)).toBe(1_875_000);
    });
  });

  it("reprice mid-interval splits accounting at the switch timestamp", async () => {
    const viewer = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      await meter.openWatch(viewer, TRACK, "720p30", "h", T0);
      // Publisher switches 720p30 → 1080p30 at +30s; the open watch is repriced at that instant.
      await meter.repriceStream(TRACK, "1080p30", T0 + 30_000);
      await meter.closeWatch(viewer, TRACK, T0 + MINUTE);
      // 30s @ 720p30 h (1200 kbps) = 4,500,000 ; 30s @ 1080p30 h (2000 kbps) = 7,500,000
      expect(sumEgress(state)).toBe(12_000_000);
    });
  });

  it("reprice only touches watches OF the named stream + keeps each watcher's rid", async () => {
    const viewerH = crypto.randomUUID();
    const viewerL = crypto.randomUUID();
    const other = crypto.randomUUID();
    await runInDurableObject(freshRoom(), async (_i, state) => {
      const meter = new CostMeter(state, {});
      await meter.openWatch(viewerH, TRACK, "720p30", "h", T0);
      await meter.openWatch(viewerL, TRACK, "720p30", "l", T0);
      await meter.openWatch(other, "screen:pub:2", "720p30", "h", T0);
      await meter.repriceStream(TRACK, "1080p30", T0 + 30_000);
      await meter.closeWatch(viewerH, TRACK, T0 + MINUTE);
      await meter.closeWatch(viewerL, TRACK, T0 + MINUTE);
      await meter.closeWatch(other, "screen:pub:2", T0 + MINUTE);
      // viewerH: 30s@1200 + 30s@2000 = 12,000,000 ; viewerL: 60s@250 = 1,875,000 (rid preserved, l-rate
      // is preset-independent so the reprice is a no-op on its bytes) ; other (different stream): 60s@1200
      // = 9,000,000 (untouched by the reprice).
      expect(sumEgress(state)).toBe(12_000_000 + 1_875_000 + 9_000_000);
    });
  });
});
