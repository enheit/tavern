import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";

// FR-28 layered upgrade (Task-3): @vencord/venmic (MPL-2.0) native PipeWire loopback for desktop
// Linux stream audio. Where available it REPLACES the pactl remap + AEC self-exclusion path with a
// first-class virtual mic whose graph links every application's output EXCEPT Tavern's own audio
// (excluded by the Electron audio-service PID at the PipeWire level) — no echo canceller in the
// content path, so music/game fidelity survives double-talk. Every failure mode (not Linux, module
// missing — it is an optionalDependency skipped off-Linux and on musl, no PipeWire, no prebuild,
// link error, no audio-service process yet, host crash/timeout) falls back SILENTLY to the shipped
// remap path in capture.ts. The integration is written from venmic's public API; Vesktop's GPL-3.0
// integration files were not copied (venmic itself is MPL-2.0 — license-compatible).
//
// The native module is hosted in a utilityProcess (venmicHost.ts), NOT in-process: libpipewire
// asserts abort the hosting process (observed on 0.5.0 / Void Linux: `pw_proxy_destroy: Assertion
// !proxy->destroyed failed` → SIGABRT killed the whole app mid-share), and Chromium's Wayland
// portal capture speaks PipeWire from this same browser process. A dead host = a failed link = the
// remap fallback; never a dead app.

// venmic hardcodes its virtual node name upstream — the renderer's device auto-pick prefers this
// exact label (app/src/media/capture.ts VENMIC_STREAM_AUDIO_LABEL mirrors it).
export const VENMIC_NODE_NAME = "vencord-screen-share";

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

// The slice of Electron.UtilityProcess the integration uses — injectable for unit tests.
export interface VenmicHostLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
  kill(): boolean;
}

function forkVenmicHost(): VenmicHostLike {
  // Sibling bundle in out/main (electron-vite entry). Vite's CJS build shims import.meta.url, and
  // utilityProcess.fork loads modules from inside the asar directly.
  const entry = fileURLToPath(new URL("./venmicHost.js", import.meta.url));
  return utilityProcess.fork(entry, [], { serviceName: "tavern-venmic" });
}

// Injection seams default to the real environment (matches capture.ts's `platform` param style).
export interface VenmicDeps {
  platform?: NodeJS.Platform;
  metrics?: () => ProcessMetricLike[];
  fork?: () => VenmicHostLike;
  timeoutMs?: number;
}

// A hung host (PipeWire loop stuck) must not stall share start forever — kill it and fall back.
const LINK_TIMEOUT_MS = 5000;

let host: VenmicHostLike | null = null;
let linked = false;
let pending = false;

const linkResultSchema = (msg: unknown): boolean | null => {
  if (typeof msg !== "object" || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  return rec.t === "link.result" && typeof rec.ok === "boolean" ? rec.ok : null;
};

// True → the venmic virtual mic is live and the renderer will find "vencord-screen-share" among
// its audio inputs. False → caller uses the pactl remap path. Never throws and never hangs.
export async function prepareVenmic(deps: VenmicDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return false;
  // A link is already in flight (double share start) — report failure; the fallback handles it.
  if (pending) return false;
  try {
    const pid = resolveAudioServicePid(deps.metrics?.() ?? app.getAppMetrics());
    // No audio-service process yet (no audio has ever played) → without the exclusion Tavern's
    // own voices would leak into the stream; the remap+AEC path handles that case instead.
    if (pid === null) return false;
    if (host === null) {
      const child = ((deps.fork ?? forkVenmicHost)() as VenmicHostLike | null) ?? null;
      if (child === null) return false;
      // Attached once per child, at fork time: crash (native abort) or kill → forget the child so
      // the next share respawns a fresh one. The exit also tore the virtual mic down with it.
      child.once("exit", () => {
        if (host === child) {
          host = null;
          linked = false;
        }
      });
      host = child;
    }
    const child = host;
    pending = true;
    const ok = await new Promise<boolean>((resolve) => {
      const finish = (result: boolean): void => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        resolve(result);
      };
      const timer = setTimeout(() => {
        // Hung host (PipeWire loop stuck) — kill it; the fork-time exit listener forgets it.
        child.kill();
        finish(false);
      }, deps.timeoutMs ?? LINK_TIMEOUT_MS);
      const onMessage = (msg: unknown): void => {
        const result = linkResultSchema(msg);
        if (result !== null) finish(result);
      };
      const onExit = (): void => {
        finish(false);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      // oxlint-disable-next-line require-post-message-target-origin -- Electron UtilityProcess, not Window
      child.postMessage({ t: "link", pid });
    });
    linked = ok;
    return ok;
  } catch (err) {
    console.warn("[venmic] unavailable — falling back to the pactl remap path", err);
    linked = false;
    return false;
  } finally {
    pending = false;
  }
}

// Best-effort teardown (share stop / app quit): the virtual mic must not outlive the share, or it
// would keep mixing application audio nobody consumes. Fire-and-forget — a dead host has already
// torn the mic down with it.
export function releaseVenmic(): void {
  if (!linked) return;
  linked = false;
  try {
    // oxlint-disable-next-line require-post-message-target-origin -- Electron UtilityProcess, not Window
    host?.postMessage({ t: "unlink" });
  } catch {
    // Host died between the flag check and the send — its mic died with it.
  }
}

// App quit: take the host down with the app (will-quit in index.ts).
export function shutdownVenmic(): void {
  releaseVenmic();
  try {
    host?.kill();
  } catch {
    // Already gone.
  }
  host = null;
}

// Test seam: module-level host/link state must not leak between unit tests.
export function resetVenmicForTest(): void {
  host = null;
  linked = false;
  pending = false;
}
