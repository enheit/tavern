import type { DeepFilterNet3Core } from "deepfilternet3-noise-filter";
// The worklet/wasm files ship as real self-origin assets (?url): CSP script-src has no data:, so
// they must never be inlined — vite.config's assetsInlineLimit excludes this package.
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWasmSimdPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
// ?url is a Vite construct: the import IS the asset URL string (a default export Vite
// synthesizes); oxlint resolves the raw worklet file and sees no default export there.
// oxlint-disable-next-line import/default
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import type { NoiseSuppressionMode } from "@/stores/settings";

// FR-22 WASM noise-suppression modes (rnnoise = RNNoise ~150 KB, deepfilter = DeepFilterNet3
// ~24 MB self-hosted assets). The pipeline runs inside the ONE app AudioContext (§7.3) — this
// module never constructs a context (§7.2 ports gate); capture.getMic passes the graph's context.
// Both packages are imported DYNAMICALLY: their node classes extend AudioWorkletNode at module
// scope, which throws in jsdom — a static import would break every unit test that imports
// capture.ts. Dynamic import also code-splits them out of the main bundle.

type WorkletMode = Extract<NoiseSuppressionMode, "rnnoise" | "deepfilter">;

// DeepFilterNet assets are self-hosted under public/deepfilternet (CSP connect-src is 'self' —
// the package's default cdn.mezon.ai origin is unreachable by policy and untrusted by choice).
const DEEPFILTER_ASSET_BASE = "/deepfilternet";

// RNNoise wasm bytes: fetched once per app run (loadRnnoise picks the SIMD build itself).
let rnnoiseWasm: Promise<ArrayBuffer> | null = null;
// DeepFilterNet core: assets fetched + wasm compiled once per app run, on first use of the mode.
let dfnCore: Promise<DeepFilterNet3Core> | null = null;

// ONE worklet node per (context, mode), reused across mid-call retoggles. Two reasons:
// (a) the DFN loader calls addModule with a fresh blob on every createAudioWorkletNode — a second
//     call on the same context would re-register 'deepfilter-audio-processor' and throw;
// (b) RnnoiseWorkletNode.destroy() leaks (sapphi-red/web-noise-suppressor#42) — never churn nodes;
//     they die with the context when the voice session's graph closes.
const nodeCache = new WeakMap<AudioContext, Map<WorkletMode, Promise<AudioWorkletNode>>>();

async function createRnnoiseNode(ctx: AudioContext): Promise<AudioWorkletNode> {
  const { loadRnnoise, RnnoiseWorkletNode } = await import("@sapphi-red/web-noise-suppressor");
  rnnoiseWasm ??= loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseWasmSimdPath });
  const [wasmBinary] = await Promise.all([
    rnnoiseWasm,
    ctx.audioWorklet.addModule(rnnoiseWorkletPath),
  ]);
  return new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
}

async function createDeepfilterNode(ctx: AudioContext): Promise<AudioWorkletNode> {
  dfnCore ??= (async () => {
    const { DeepFilterNet3Core: Core } = await import("deepfilternet3-noise-filter");
    const core = new Core({
      sampleRate: 48000, // the app graph rate (§7.3); DFN3 is a 48 kHz model
      noiseReductionLevel: 50,
      assetConfig: { cdnUrl: DEEPFILTER_ASSET_BASE },
    });
    await core.initialize();
    return core;
  })();
  const core = await dfnCore.catch((err: unknown) => {
    dfnCore = null; // failed asset fetch/compile must not poison every later attempt
    throw err;
  });
  return core.createAudioWorkletNode(ctx);
}

function workletNodeFor(ctx: AudioContext, mode: WorkletMode): Promise<AudioWorkletNode> {
  let perCtx = nodeCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    nodeCache.set(ctx, perCtx);
  }
  const cached = perCtx.get(mode);
  if (cached) return cached;
  const node = mode === "rnnoise" ? createRnnoiseNode(ctx) : createDeepfilterNode(ctx);
  node.catch(() => perCtx.delete(mode)); // don't cache a failed load
  perCtx.set(mode, node);
  return node;
}

// raw mic → source → worklet → MediaStreamAudioDestinationNode; returns the processed track the
// engine publishes/holds. Fails OPEN: any load/graph error returns the raw track (voice keeps
// working without suppression) — never a failed join. The processed track's stop() is wrapped to
// also release the raw gUM track (stopping a destination track never releases the mic — the OS
// record indicator would stay on) and detach this acquisition's source/dest from the shared node.
export async function applyNoiseWorklet(
  ctx: AudioContext,
  raw: MediaStreamTrack,
  mode: WorkletMode,
): Promise<MediaStreamTrack> {
  try {
    const node = await workletNodeFor(ctx, mode);
    const source = ctx.createMediaStreamSource(new MediaStream([raw]));
    // Voice is mono end-to-end (Opus mic track): downmix ahead of the model — RNNoise runs
    // per-channel (maxChannels 1) and DFN3 expects mono frames.
    source.channelCount = 1;
    source.channelCountMode = "explicit";
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    source.connect(node);
    node.connect(dest);
    const processed = dest.stream.getAudioTracks()[0];
    if (!processed) throw new Error("no audio track in destination stream");
    const stopProcessed = processed.stop.bind(processed);
    let disposed = false;
    processed.stop = () => {
      if (!disposed) {
        disposed = true;
        raw.stop();
        source.disconnect();
        node.disconnect(dest); // node itself stays cached for the next acquisition
      }
      stopProcessed();
    };
    return processed;
  } catch (err) {
    console.warn(`[noise] ${mode} pipeline unavailable — using unprocessed mic`, err);
    return raw;
  }
}
