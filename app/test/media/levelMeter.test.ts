import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchSpeaking } from "@/media/levelMeter";

// Drive the rAF loop by hand: capture the scheduled callback and step it with a controlled clock,
// filling the analyser buffer with a synthetic constant amplitude (RMS of a constant = the constant).
let rafCb: FrameRequestCallback | null = null;
let now = 0;
let amplitude = 0;

function frameAt(t: number): void {
  now = t;
  rafCb?.(t);
}

function analyserAt(fftSize = 8): AnalyserNode {
  return {
    fftSize,
    getFloatTimeDomainData: (array: Float32Array) => array.fill(amplitude),
  } as unknown as AnalyserNode;
}

beforeEach(() => {
  rafCb = null;
  now = 0;
  amplitude = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCb = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FR-23 speaking detection", () => {
  it("RMS 0.05 sustained for 120 ms → speaking", () => {
    const events: boolean[] = [];
    amplitude = 0.05;
    watchSpeaking(analyserAt(), (s) => events.push(s));
    frameAt(0); // first crossing — not yet sustained
    expect(events).toEqual([]);
    frameAt(120); // sustained ≥100 ms → speaking
    expect(events).toEqual([true]);
  });

  it("RMS 0.05 for only 60 ms → not speaking (sustain gate)", () => {
    const events: boolean[] = [];
    amplitude = 0.05;
    watchSpeaking(analyserAt(), (s) => events.push(s));
    frameAt(0);
    frameAt(60);
    expect(events).toEqual([]);
  });

  it("drop below threshold clears only after the 300 ms hangover", () => {
    const events: boolean[] = [];
    amplitude = 0.05;
    watchSpeaking(analyserAt(), (s) => events.push(s));
    frameAt(0);
    frameAt(120);
    expect(events).toEqual([true]);

    amplitude = 0; // silent
    frameAt(200); // hangover starts
    frameAt(499); // 299 ms < 300 ms → still speaking
    expect(events).toEqual([true]);
    frameAt(500); // 300 ms → clears
    expect(events).toEqual([true, false]);
  });

  it("honours custom thresholds and stops the loop on unsubscribe", () => {
    const events: boolean[] = [];
    amplitude = 0.5;
    const stop = watchSpeaking(analyserAt(), (s) => events.push(s), {
      thresholdRms: 0.4,
      sustainMs: 50,
      hangoverMs: 100,
    });
    frameAt(0);
    frameAt(50);
    expect(events).toEqual([true]);
    stop();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });
});
