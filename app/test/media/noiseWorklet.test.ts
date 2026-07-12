import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeStream, fakeTrack } from "../fakes/media";

// DeepFilterNet3Core subclasses AudioWorkletNode territory (throws in jsdom), so the dynamic import
// inside noiseWorklet.ts MUST be mocked — mirroring why it is dynamic at all. `setSuppressionLevel`
// is the model's one live knob (the strength slider posts to it).
const dfn = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  createAudioWorkletNode: vi.fn(),
  setSuppressionLevel: vi.fn(),
  ctor: vi.fn(),
}));
vi.mock("deepfilternet3-noise-filter", () => ({
  DeepFilterNet3Core: class {
    constructor(cfg: unknown) {
      dfn.ctor(cfg);
    }
    initialize = dfn.initialize;
    createAudioWorkletNode = dfn.createAudioWorkletNode;
    setSuppressionLevel = dfn.setSuppressionLevel;
  },
}));

// noiseWorklet holds module-level singletons (dfnCore, nodeCache) — reset the module per test so
// state (a cached good core, a per-context node) never leaks across cases.
let applyNoiseWorklet: (typeof import("@/media/noiseWorklet"))["applyNoiseWorklet"];
let setDeepfilterAtten: (typeof import("@/media/noiseWorklet"))["setDeepfilterAtten"];

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

beforeEach(async () => {
  vi.resetModules();
  dfn.initialize.mockReset().mockResolvedValue(undefined);
  dfn.createAudioWorkletNode.mockReset().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() });
  dfn.setSuppressionLevel.mockReset();
  dfn.ctor.mockReset();
  // new MediaStream([raw]) inside applyNoiseWorklet — jsdom has no MediaStream.
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(public tracks: unknown[]) {}
    },
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  ({ applyNoiseWorklet, setDeepfilterAtten } = await import("@/media/noiseWorklet"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("applyNoiseWorklet (deepfilter)", () => {
  it("builds source → worklet → destination mono, returns processed, and syncs the strength", async () => {
    const node = { connect: vi.fn(), disconnect: vi.fn() };
    dfn.createAudioWorkletNode.mockReturnValue(node);
    const { ctx, source } = fakeCtx();
    const raw = fakeTrack("audio");

    const processed = await applyNoiseWorklet(ctx, raw, 30);

    expect(processed).not.toBe(raw);
    expect(source.channelCount).toBe(1);
    expect(source.channelCountMode).toBe("explicit");
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalled();
    // The node is built at the core's construction level; createDeepfilterNode re-syncs to `atten`.
    expect(dfn.setSuppressionLevel).toHaveBeenCalledWith(30);
    // Self-hosted assets only (CSP 'self') — never the package's default CDN.
    expect(dfn.ctor).toHaveBeenCalledWith(
      expect.objectContaining({ assetConfig: { cdnUrl: "/deepfilternet" } }),
    );
  });

  it("stop() releases the raw mic + detaches the graph exactly once", async () => {
    const node = { connect: vi.fn(), disconnect: vi.fn() };
    dfn.createAudioWorkletNode.mockReturnValue(node);
    const { ctx, source, dest } = fakeCtx();
    const raw = fakeTrack("audio");

    const processed = await applyNoiseWorklet(ctx, raw, 30);
    processed.stop();
    processed.stop();

    expect(raw.stop).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(node.disconnect).toHaveBeenCalledTimes(1);
    expect(node.disconnect).toHaveBeenCalledWith(dest);
  });

  it("reuses ONE worklet node per context across re-acquisitions", async () => {
    const { ctx } = fakeCtx();

    await applyNoiseWorklet(ctx, fakeTrack("audio"), 30);
    await applyNoiseWorklet(ctx, fakeTrack("audio"), 30);

    expect(dfn.createAudioWorkletNode).toHaveBeenCalledTimes(1);
  });

  it("fails OPEN to the raw track when the destination has no audio track", async () => {
    const { ctx } = fakeCtx({ destTracks: [] });
    const raw = fakeTrack("audio");

    await expect(applyNoiseWorklet(ctx, raw, 30)).resolves.toBe(raw);
  });

  it("fails OPEN to the raw track when the model fails to load, then recovers next attempt", async () => {
    dfn.initialize.mockRejectedValueOnce(new Error("asset fetch failed"));
    const raw = fakeTrack("audio");

    // First attempt: DFN init rejects → unprocessed mic, and the core cache is poison-reset.
    await expect(applyNoiseWorklet(fakeCtx().ctx, raw, 30)).resolves.toBe(raw);

    // Second attempt on a fresh context: init now succeeds → processed track, DFN built for that ctx.
    const second = fakeCtx();
    const processed = await applyNoiseWorklet(second.ctx, fakeTrack("audio"), 30);
    expect(processed).not.toBe(raw);
    expect(dfn.createAudioWorkletNode).toHaveBeenCalledWith(second.ctx);
  });
});

describe("setDeepfilterAtten (live strength)", () => {
  it("posts the new level to the running core", async () => {
    const { ctx } = fakeCtx();
    await applyNoiseWorklet(ctx, fakeTrack("audio"), 30); // build the core + node
    dfn.setSuppressionLevel.mockClear();

    setDeepfilterAtten(60);
    await Promise.resolve(); // the setter awaits the core promise before posting

    expect(dfn.setSuppressionLevel).toHaveBeenCalledWith(60);
  });

  it("is a no-op before the core exists (not in voice yet)", async () => {
    setDeepfilterAtten(60);
    await Promise.resolve();

    expect(dfn.setSuppressionLevel).not.toHaveBeenCalled();
  });
});
