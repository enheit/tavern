import { invoke } from '@tauri-apps/api/core';
import { engine } from '../engine';
import { onEngineEvent } from '../events';

// S6.3 boot-time runtime requirement checks (§1): WebCodecs on every OS (blocking
// error screen when absent), plus the Linux portal/PipeWire screen-capture probe
// (typed, dismissible dialog — voice/chat still work without capture).

export function isLinux(): boolean {
  return typeof navigator !== 'undefined' && /\bLinux\b/.test(navigator.userAgent);
}

export class RuntimeStore {
  // Assume ok until probed so tests/browser dev never flash the error screen.
  webcodecsOk = $state(true);
  captureError = $state<string | null>(null);
  // Set by `update://ready` once the updater has installed a new version on disk;
  // clicking the App.svelte pill invokes `relaunch` to boot into it.
  updateVersion = $state<string | null>(null);

  async probe(): Promise<void> {
    // WebCodecs is required only by the DESKTOP video path (chunk decode). The web
    // build (S7) renders watched streams via <video srcObject> — never block there.
    const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    const ok = !tauri || typeof VideoDecoder !== 'undefined';
    this.webcodecsOk = ok;
    await engine.setWebcodecsOk(ok); // reported via engine_status().webcodecsOk (§1)
    if (isLinux()) this.captureError = await engine.captureProbe();
  }

  dismissCaptureError(): void {
    this.captureError = null;
  }
}

export const runtime = new RuntimeStore();

onEngineEvent('update://ready', (version) => {
  runtime.updateVersion = String(version);
});

export async function relaunch(): Promise<void> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) await invoke('relaunch');
}
