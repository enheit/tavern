import { engine } from '../engine';

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

  async probe(): Promise<void> {
    const ok = typeof VideoDecoder !== 'undefined';
    this.webcodecsOk = ok;
    await engine.setWebcodecsOk(ok); // reported via engine_status().webcodecsOk (§1)
    if (isLinux()) this.captureError = await engine.captureProbe();
  }

  dismissCaptureError(): void {
    this.captureError = null;
  }
}

export const runtime = new RuntimeStore();
