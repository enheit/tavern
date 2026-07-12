import { createRequire } from "node:module";
import { app } from "electron";
import { z } from "zod";

// FR-28 layered upgrade (Task-3): @vencord/venmic (MPL-2.0) native PipeWire loopback for desktop
// Linux stream audio. Where available it REPLACES the pactl remap + AEC self-exclusion path with a
// first-class virtual mic whose graph links every application's output EXCEPT Tavern's own audio
// (excluded by the Electron audio-service PID at the PipeWire level) — no echo canceller in the
// content path, so music/game fidelity survives double-talk. Every failure mode (not Linux, module
// missing — it is an optionalDependency skipped off-Linux and on musl, no PipeWire, no prebuild,
// link error, no audio-service process yet) falls back SILENTLY to the shipped remap path in
// capture.ts. The integration is written from venmic's public API; Vesktop's GPL-3.0 integration
// files were not copied (venmic itself is MPL-2.0 — license-compatible).

// venmic hardcodes its virtual node name upstream — the renderer's device auto-pick prefers this
// exact label (app/src/media/capture.ts VENMIC_STREAM_AUDIO_LABEL mirrors it).
export const VENMIC_NODE_NAME = "vencord-screen-share";

// The subset of venmic's PatchBay the integration uses (typed structurally — the package is an
// os:["linux"] optionalDependency, so its own .d.ts may not exist in the install tree).
interface VenmicPatchBay {
  link(data: { exclude: Array<Record<string, string>>; ignore_devices: boolean }): boolean;
  unlink(): boolean;
}
interface VenmicPatchBayCtor {
  new (): VenmicPatchBay;
  hasPipeWire(): boolean;
}

// §9.8 boundary parse of the native module: shape-checked with zod instead of `as`-casting the
// require result (§9.1). z.custom narrows to the ctor interface on a plain function check — the
// method surface is probed by USE inside the try/catch, exactly like any other foreign module.
const venmicModuleSchema = z.object({
  PatchBay: z.custom<VenmicPatchBayCtor>((value) => typeof value === "function"),
});

// Runtime-only loader: createRequire keeps TypeScript module resolution (and the bundler) out of
// it entirely — on macOS/Windows dev machines the package directory simply does not exist and the
// require throws into the caller's catch.
function loadPatchBayCtor(): VenmicPatchBayCtor {
  const requireNative = createRequire(import.meta.url);
  const mod: unknown = requireNative("@vencord/venmic");
  return venmicModuleSchema.parse(mod).PatchBay;
}

// The one process whose audio must never enter the capture: Chromium plays ALL renderer audio
// (voices, soundboard, watched streams) through the single utility "Audio Service" process, so
// excluding its PID at the PipeWire level removes Tavern's own output from the virtual mic.
// Matched on Electron's ProcessMetric fields (name is the stable non-localized label; serviceName
// carries the mojo service id on newer Electrons).
export interface ProcessMetricLike {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
}

export function resolveAudioServicePid(metrics: ProcessMetricLike[]): number | null {
  const audio = metrics.find(
    (m) =>
      m.type === "Utility" && (m.name === "Audio Service" || /audio/i.test(m.serviceName ?? "")),
  );
  return audio?.pid ?? null;
}

// Injection seams default to the real environment (matches capture.ts's `platform` param style).
export interface VenmicDeps {
  platform?: NodeJS.Platform;
  loadCtor?: () => VenmicPatchBayCtor;
  metrics?: () => ProcessMetricLike[];
}

let patchBay: VenmicPatchBay | null = null;
let linked = false;

// True → the venmic virtual mic is live and the renderer will find "vencord-screen-share" among
// its audio inputs. False → caller uses the pactl remap path. Never throws.
export async function prepareVenmic(deps: VenmicDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return false;
  try {
    const ctor = (deps.loadCtor ?? loadPatchBayCtor)();
    if (!ctor.hasPipeWire()) return false;
    const pid = resolveAudioServicePid(deps.metrics?.() ?? app.getAppMetrics());
    // No audio-service process yet (no audio has ever played) → without the exclusion Tavern's
    // own voices would leak into the stream; the remap+AEC path handles that case instead.
    if (pid === null) return false;
    patchBay ??= new ctor();
    // ignore_devices: capture application streams only, never hardware device nodes — the device
    // monitor would re-include everything (own playout too) and defeat the PID exclusion.
    linked = patchBay.link({
      exclude: [{ "application.process.id": String(pid) }],
      ignore_devices: true,
    });
    return linked;
  } catch (err) {
    console.warn("[venmic] unavailable — falling back to the pactl remap path", err);
    linked = false;
    return false;
  }
}

// Best-effort teardown (share stop / app quit). unlink() only when a link succeeded — venmic
// throws on an unlinked PatchBay; a dead PipeWire connection at quit is equally non-actionable.
export function releaseVenmic(): void {
  if (!linked) return;
  linked = false;
  try {
    patchBay?.unlink();
  } catch {
    // PipeWire went away mid-run — nothing left to release.
  }
}

// Test seam: module-level PatchBay/link state must not leak between unit tests.
export function resetVenmicForTest(): void {
  patchBay = null;
  linked = false;
}
