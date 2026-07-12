import type { DeepFilterNet3Core } from "deepfilternet3-noise-filter";

// DeepFilterNet3 (~24 MB self-hosted assets) is the app's single WASM noise-suppression model,
// applied AFTER capture inside the ONE app AudioContext (§7.3) — this module never constructs a
// context (§7.2 ports gate); capture.getMic passes the graph's context. All processing runs
// ON-DEVICE (AudioWorklet + WASM in the browser) before the mic is published; the SFU forwards
// already-clean audio. The package is imported DYNAMICALLY: its node class extends AudioWorkletNode
// at module scope, which throws in jsdom — a static import would break every unit test that imports
// capture.ts. Dynamic import also code-splits the model loader out of the main bundle. (RNNoise was
// removed: DeepFilterNet3 is the only model, tunable via its attenuation limit — see
// stores/settings.ts DEEPFILTER_ATTEN_*.)

// DeepFilterNet assets are self-hosted under public/deepfilternet (CSP connect-src is 'self' — the
// package's default cdn.mezon.ai origin is unreachable by policy and untrusted by choice).
const DEEPFILTER_ASSET_BASE = "/deepfilternet";

// DeepFilterNet core: assets fetched + wasm compiled once per app run, on first use of the mode.
let dfnCore: Promise<DeepFilterNet3Core> | null = null;

function loadCore(): Promise<DeepFilterNet3Core> {
  dfnCore ??= (async () => {
    const { DeepFilterNet3Core: Core } = await import("deepfilternet3-noise-filter");
    const core = new Core({
      sampleRate: 48000, // the app graph rate (§7.3); DFN3 is a 48 kHz model
      assetConfig: { cdnUrl: DEEPFILTER_ASSET_BASE },
    });
    await core.initialize();
    return core;
  })();
  return dfnCore.catch((err: unknown) => {
    dfnCore = null; // failed asset fetch/compile must not poison every later attempt
    throw err;
  });
}

// Live attenuation change from the settings slider — a plain postMessage to the worklet, so the
// running mic is retuned WITHOUT a re-acquire (gapless). No-op until the core + its worklet node
// exist (not in voice, or assets still loading); the next acquisition builds the node at the
// persisted level (createDeepfilterNode re-syncs), so nothing is lost.
export function setDeepfilterAtten(level: number): void {
  if (dfnCore === null) return;
  void dfnCore.then((core) => core.setSuppressionLevel(level)).catch(() => undefined);
}

// ONE worklet node per context, reused across mid-call retoggles: the DFN loader calls addModule
// with a fresh blob on every createAudioWorkletNode — a second call on the same context would
// re-register 'deepfilter-audio-processor' and throw. The node dies with the context when the
// voice session's graph closes.
const nodeCache = new WeakMap<AudioContext, Promise<AudioWorkletNode>>();

async function createDeepfilterNode(ctx: AudioContext, atten: number): Promise<AudioWorkletNode> {
  const core = await loadCore();
  const node = await core.createAudioWorkletNode(ctx);
  // The node is built with the core's construction-time level; re-sync to the caller's current
  // level so a rejoin after the user moved the strength slider reflects their latest choice.
  core.setSuppressionLevel(atten);
  return node;
}

function workletNodeFor(ctx: AudioContext, atten: number): Promise<AudioWorkletNode> {
  const cached = nodeCache.get(ctx);
  if (cached) {
    // Same context already has the node — just re-sync the level (cheap postMessage on resolve).
    void cached.then(() => setDeepfilterAtten(atten)).catch(() => undefined);
    return cached;
  }
  const node = createDeepfilterNode(ctx, atten);
  node.catch(() => nodeCache.delete(ctx)); // don't cache a failed load
  nodeCache.set(ctx, node);
  return node;
}

// One suppression pipeline attempt: raw mic → source → worklet → MediaStreamAudioDestinationNode;
// returns the processed track the engine publishes/holds. The processed track's stop() is wrapped
// to also release the raw gUM track (stopping a destination track never releases the mic — the OS
// record indicator would stay on) and detach this acquisition's source/dest from the shared node.
async function buildPipeline(
  ctx: AudioContext,
  raw: MediaStreamTrack,
  atten: number,
): Promise<MediaStreamTrack> {
  const node = await workletNodeFor(ctx, atten);
  const source = ctx.createMediaStreamSource(new MediaStream([raw]));
  // Voice is mono end-to-end (Opus mic track): downmix ahead of the model — DFN3 expects mono frames.
  source.channelCount = 1;
  source.channelCountMode = "explicit";
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  source.connect(node);
  node.connect(dest);
  const processed = dest.stream.getAudioTracks()[0];
  if (!processed) {
    source.disconnect();
    node.disconnect(dest); // leave the cached node reusable for the next attempt
    throw new Error("no audio track in destination stream");
  }
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
}

// DeepFilterNet fails OPEN to the raw track: any load/asset failure (24 MB fetch — offline or a
// blocked path must not cost the user their voice) keeps the mic working unprocessed rather than
// failing the join. The next acquisition (join/retoggle) re-attempts DFN — a transient fetch failure
// heals itself, and loadCore's poison-reset keeps a failed core from sticking.
export async function applyNoiseWorklet(
  ctx: AudioContext,
  raw: MediaStreamTrack,
  atten: number,
): Promise<MediaStreamTrack> {
  try {
    return await buildPipeline(ctx, raw, atten);
  } catch (err) {
    console.warn("[noise] deepfilter pipeline unavailable — using unprocessed mic", err);
    return raw;
  }
}
