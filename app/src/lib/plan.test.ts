import { describe, expect, it } from 'vitest';
import { encodingsFor, planScreen, planWebcam } from './plan';

// Mirrors crates/capture/src/config.rs + crates/engine/src/video.rs table tests so the
// TS port can never drift from the Rust engine's §1 layers.
describe('planScreen', () => {
  // (selHeight, fps, simulcast, hKbps, w, h) — the exact Rust test table.
  const cases: [number, number, boolean, number, number, number][] = [
    [1440, 15, true, 3000, 2560, 1440],
    [1440, 30, true, 4000, 2560, 1440],
    [1440, 60, true, 6000, 2560, 1440],
    [1440, 120, true, 8000, 2560, 1440],
    [1080, 15, true, 1900, 1920, 1080],
    [1080, 30, true, 2500, 1920, 1080],
    [1080, 60, true, 3750, 1920, 1080],
    [1080, 120, true, 5000, 1920, 1080],
    [720, 15, true, 1150, 1280, 720],
    [720, 30, true, 1500, 1280, 720],
    [720, 60, true, 2250, 1280, 720],
    [720, 120, true, 3000, 1280, 720],
    [480, 15, false, 800, 852, 480],
    [480, 30, false, 800, 852, 480],
    [480, 60, false, 1200, 852, 480],
    [480, 120, false, 1600, 852, 480],
    [360, 15, false, 400, 640, 360],
    [360, 30, false, 500, 640, 360],
    [360, 60, false, 750, 640, 360],
    [360, 120, false, 1000, 640, 360],
    [0, 15, true, 3000, 2880, 1800],
    [0, 30, true, 4000, 2880, 1800],
    [0, 60, true, 6000, 2880, 1800],
    [0, 120, true, 8000, 2880, 1800],
  ];

  it('matches the §1 table for all rows × all fps', () => {
    for (const [sel, fps, sim, kbps, w, h] of cases) {
      const [srcW, srcH] = sel === 0 ? [2880, 1800] : [5120, 2880];
      const plan = planScreen(sel, fps, srcW, srcH);
      expect(plan.l !== null, `sel=${sel} fps=${fps}`).toBe(sim);
      expect(plan.h, `sel=${sel} fps=${fps}`).toEqual({ width: w, height: h, fps, maxKbps: kbps });
      if (sim) expect([plan.l!.height, plan.l!.fps, plan.l!.maxKbps]).toEqual([360, 15, 300]);
    }
    // 16:10 native: l width follows aspect (2880×1800 → 576×360).
    expect(planScreen(0, 30, 2880, 1800).l!.width).toBe(576);
  });

  it('buckets native by captured height and never upscales', () => {
    expect([planScreen(0, 30, 1920, 1080).h.maxKbps, planScreen(0, 30, 1920, 1080).l !== null]).toEqual([2500, true]);
    expect(planScreen(0, 15, 800, 500).h).toEqual({ width: 800, height: 500, fps: 15, maxKbps: 800 });
    const p = planScreen(1440, 30, 1920, 1080); // selection ≥ source → native semantics
    expect([p.h.width, p.h.height, p.h.maxKbps, p.l !== null]).toEqual([1920, 1080, 2500, true]);
    expect(planScreen(0, 30, 1919, 1079).h).toMatchObject({ width: 1918, height: 1078 });
  });
});

describe('planWebcam', () => {
  it('matches the §1 table (fps-independent bitrates, 720 carries a 180p l)', () => {
    for (const fps of [15, 30]) {
      const p720 = planWebcam(1280, 720, fps);
      expect(p720.h).toEqual({ width: 1280, height: 720, fps, maxKbps: 900 });
      expect(p720.l).toEqual({ width: 320, height: 180, fps: 15, maxKbps: 150 });
      expect(planWebcam(640, 480, fps).h.maxKbps).toBe(600);
      expect(planWebcam(640, 480, fps).l).toBeNull();
      expect(planWebcam(640, 360, fps).h.maxKbps).toBe(400);
    }
  });
});

describe('encodingsFor', () => {
  it('simulcast → [h scale 1.0, l scaled], rids h/l (the S1.3-proven shape)', () => {
    const enc = encodingsFor(planScreen(720, 30, 5120, 2880));
    expect(enc).toEqual([
      { rid: 'h', scaleResolutionDownBy: 1.0, maxBitrate: 1_500_000, maxFramerate: 30 },
      { rid: 'l', scaleResolutionDownBy: 2.0, maxBitrate: 300_000, maxFramerate: 15 },
    ]);
  });

  it('single-encoding rows emit one rid-less encoding', () => {
    const enc = encodingsFor(planWebcam(640, 480, 30));
    expect(enc).toEqual([{ scaleResolutionDownBy: 1.0, maxBitrate: 600_000, maxFramerate: 30 }]);
  });
});
