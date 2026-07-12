import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeStream, fakeTrack } from "../fakes/media";

// Both suppression packages subclass AudioWorkletNode at module scope (throws in jsdom), so the
// dynamic imports inside noiseWorklet.ts MUST be mocked — mirroring why they are dynamic at all.
const rnnoise = vi.hoisted(() => {
  const instances: Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  class RnnoiseWorkletNode {
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(
      public ctx: unknown,
      public opts: unknown,
    ) {
      instances.push(this);
    }
  }
  return { instances, RnnoiseWorkletNode, loadRnnoise: vi.fn(async () => new ArrayBuffer(4)) };
});
vi.mock("@sapphi-red/web-noise-suppressor", () => ({
  loadRnnoise: rnnoise.loadRnnoise,
  RnnoiseWorkletNode: rnnoise.RnnoiseWorkletNode,
}));

const dfn = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  createAudioWorkletNode: vi.fn(),
  ctor: vi.fn(),
}));
vi.mock("deepfilternet3-noise-filter", () => ({
  DeepFilterNet3Core: class {
    constructor(cfg: unknown) {
      dfn.ctor(cfg);
    }
    initialize = dfn.initialize;
    createAudioWorkletNode = dfn.createAudioWorkletNode;
  },
}));

import { applyNoiseWorklet } from "@/media/noiseWorklet";

function fakeCtx(over: { destTracks?: MediaStreamTrack[] } = {}) {
  const source = {
    channelCount: 2,
    channelCountMode: "max",
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const dest = {
    channelCount: 2,
    stream: fakeStream({ audio: over.destTracks ?? [fakeTrack("audio")] }),
  };
  const ctx = {
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(() => source),
    createMediaStreamDestination: vi.fn(() => dest),
  };
  return { ctx: ctx as unknown as AudioContext, source, dest };
}

beforeEach(() => {
  // new MediaStream([raw]) inside applyNoiseWorklet — jsdom has no MediaStream.
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(public tracks: unknown[]) {}
    },
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FR-22 applyNoiseWorklet (rnnoise)", () => {
  it("builds source → worklet → destination mono and returns the processed track", async () => {
    const { ctx, source } = fakeCtx();
    const raw = fakeTrack("audio");

    const processed = await applyNoiseWorklet(ctx, raw, "rnnoise");

    expect(processed).not.toBe(raw);
    expect(source.channelCount).toBe(1);
    expect(source.channelCountMode).toBe("explicit");
    const node = rnnoise.instances.at(-1);
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(node?.connect).toHaveBeenCalled();
  });

  it("stop() releases the raw mic + detaches the graph exactly once", async () => {
    const { ctx, source, dest } = fakeCtx();
    const raw = fakeTrack("audio");

    const processed = await applyNoiseWorklet(ctx, raw, "rnnoise");
    processed.stop();
    processed.stop();

    expect(raw.stop).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    const node = rnnoise.instances.at(-1);
    expect(node?.disconnect).toHaveBeenCalledTimes(1);
    expect(node?.disconnect).toHaveBeenCalledWith(dest);
  });

  it("reuses ONE worklet node per context across re-acquisitions", async () => {
    const { ctx } = fakeCtx();
    const before = rnnoise.instances.length;

    await applyNoiseWorklet(ctx, fakeTrack("audio"), "rnnoise");
    await applyNoiseWorklet(ctx, fakeTrack("audio"), "rnnoise");

    expect(rnnoise.instances.length).toBe(before + 1);
  });

  it("fails OPEN to the raw track when the destination has no audio track", async () => {
    const { ctx } = fakeCtx({ destTracks: [] });
    const raw = fakeTrack("audio");

    await expect(applyNoiseWorklet(ctx, raw, "rnnoise")).resolves.toBe(raw);
  });
});

// Injects an RNNoise failure for ONE context: the wasm bytes are cached module-level after the
// rnnoise describe above, so the only per-attempt failure point is the context's addModule.
function breakRnnoiseOn(ctx: AudioContext): void {
  (ctx as unknown as { audioWorklet: { addModule: () => Promise<void> } }).audioWorklet.addModule =
    async () => {
      throw new Error("worklet module load failed");
    };
}

describe("FR-22 applyNoiseWorklet (deepfilter)", () => {
  // Ordered before the recovery test: dfnCore is still uncached here, so the rejected init is the
  // one that runs (a cached good core would bypass initialize entirely).
  it("fails OPEN to the raw track only when BOTH models are unavailable", async () => {
    dfn.initialize.mockRejectedValueOnce(new Error("asset fetch failed"));
    const raw = fakeTrack("audio");
    const { ctx } = fakeCtx();
    breakRnnoiseOn(ctx);

    await expect(applyNoiseWorklet(ctx, raw, "deepfilter")).resolves.toBe(raw);
  });

  it("falls back to RNNoise when DFN init fails (Task-2 chain), then DFN recovers next attempt", async () => {
    dfn.initialize.mockRejectedValueOnce(new Error("asset fetch failed"));
    const raw = fakeTrack("audio");
    const first = fakeCtx();
    const rnnoiseBefore = rnnoise.instances.length;

    // Failed DFN init → the RNNoise pipeline takes over (processed track, not raw), and the DFN
    // core cache must not be poisoned for later attempts.
    const fallback = await applyNoiseWorklet(first.ctx, raw, "deepfilter");
    expect(fallback).not.toBe(raw);
    expect(rnnoise.instances.length).toBe(rnnoiseBefore + 1);
    const node = rnnoise.instances.at(-1);
    expect(first.source.connect).toHaveBeenCalledWith(node);

    const second = fakeCtx();
    const dfnNode = { connect: vi.fn(), disconnect: vi.fn() };
    dfn.createAudioWorkletNode.mockReturnValue(dfnNode);

    const processed = await applyNoiseWorklet(second.ctx, fakeTrack("audio"), "deepfilter");
    expect(processed).not.toBe(raw);
    expect(dfn.createAudioWorkletNode).toHaveBeenCalledWith(second.ctx);
    // …and no NEW RNNoise pipeline was needed once DFN loads.
    expect(rnnoise.instances.length).toBe(rnnoiseBefore + 1);
    // Self-hosted assets only (CSP 'self') — never the package's default CDN.
    expect(dfn.ctor).toHaveBeenCalledWith(
      expect.objectContaining({ assetConfig: { cdnUrl: "/deepfilternet" } }),
    );
  });

  it("mode 'rnnoise' never attempts DFN on failure (chain is deepfilter-only)", async () => {
    dfn.initialize.mockClear();
    const raw = fakeTrack("audio");
    const { ctx } = fakeCtx();
    breakRnnoiseOn(ctx);

    await expect(applyNoiseWorklet(ctx, raw, "rnnoise")).resolves.toBe(raw);
    expect(dfn.initialize).not.toHaveBeenCalled();
  });
});
