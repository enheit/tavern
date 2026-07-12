import { createRequire } from "node:module";
import { z } from "zod";

// venmic utilityProcess host (FR-28 Wayland hardening). venmic runs libpipewire IN-PROCESS, and a
// PipeWire client bug aborts the whole process (observed on 0.5.0 / Void Linux: `pw_proxy_destroy:
// Assertion !proxy->destroyed failed` → SIGABRT took the entire app down mid-share). Chromium's own
// portal capture also speaks PipeWire from the browser process, so the two stacks share one address
// space there. Hosting venmic in a utilityProcess caps the blast radius: a native abort kills this
// child, the parent sees 'exit', reports link failure, and the share falls back to the pactl remap
// path — the app survives.
//
// This file is a separate electron-vite entry (out/main/venmicHost.js) and must not import
// "electron": a utilityProcess is a plain Node environment plus process.parentPort.
//
// Protocol (parent = venmic.ts): {t:"link", pid} → {t:"link.result", ok}; {t:"unlink"} → no reply.

// Mirrors venmic.ts VENMIC_NODE_NAME's upstream-hardcoded label; only typing lives here.
interface VenmicPatchBay {
  link(data: { exclude: Array<Record<string, string>>; ignore_devices: boolean }): boolean;
  unlink(): boolean;
}
interface VenmicPatchBayCtor {
  new (): VenmicPatchBay;
  hasPipeWire(): boolean;
}

// §9.8 boundary parse of the native module (same shape check the in-process loader used).
const venmicModuleSchema = z.object({
  PatchBay: z.custom<VenmicPatchBayCtor>((value) => typeof value === "function"),
});

const linkMessageSchema = z.object({ t: z.literal("link"), pid: z.number().int() });
const unlinkMessageSchema = z.object({ t: z.literal("unlink") });

function loadPatchBayCtor(): VenmicPatchBayCtor {
  const requireNative = createRequire(import.meta.url);
  const mod: unknown = requireNative("@vencord/venmic");
  return venmicModuleSchema.parse(mod).PatchBay;
}

let patchBay: VenmicPatchBay | null = null;

function link(pid: number): boolean {
  const ctor = loadPatchBayCtor();
  if (!ctor.hasPipeWire()) return false;
  patchBay ??= new ctor();
  // ignore_devices: capture application streams only, never hardware device nodes — the device
  // monitor would re-include everything (own playout too) and defeat the PID exclusion.
  return patchBay.link({
    exclude: [{ "application.process.id": String(pid) }],
    ignore_devices: true,
  });
}

process.parentPort.on("message", (event) => {
  const msg: unknown = event.data;
  const linkMsg = linkMessageSchema.safeParse(msg);
  if (linkMsg.success) {
    let ok = false;
    try {
      ok = link(linkMsg.data.pid);
    } catch (err) {
      console.warn("[venmic-host] link failed", err);
    }
    // oxlint-disable-next-line require-post-message-target-origin -- Electron ParentPort, not Window
    process.parentPort.postMessage({ t: "link.result", ok });
    return;
  }
  if (unlinkMessageSchema.safeParse(msg).success) {
    try {
      patchBay?.unlink();
    } catch {
      // Unlinked already / PipeWire went away — nothing to release.
    }
  }
});
