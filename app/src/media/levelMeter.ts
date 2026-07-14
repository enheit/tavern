import { LIMITS } from "@tavern/shared";

export interface SpeakingOpts {
  thresholdRms?: number;
  sustainMs?: number;
  hangoverMs?: number;
  // High-frequency 0..1 speech energy for animation. Unlike the latched speaking callback, this is
  // emitted every analyser frame and must feed a non-React consumer such as voiceLevelBus.
  onLevel?: (level: number) => void;
}

// Map the analyser's linear RMS onto a useful visual range. Values below the microphone noise floor
// remain closed; five times the speaking threshold is considered fully open. The speaking detector
// itself continues to compare the original RMS so animation tuning cannot change voice semantics.
export function normalizeVoiceLevel(rms: number, speakingThreshold: number): number {
  const floor = speakingThreshold * 0.35;
  const ceiling = speakingThreshold * 5;
  return Math.min(1, Math.max(0, (rms - floor) / (ceiling - floor)));
}

// FR-23 speaking detection: rAF-polled RMS on an AnalyserNode. Speaking latches on once RMS stays
// above threshold for `sustainMs`, and latches off once it stays below for `hangoverMs` (constants
// from LIMITS). `cb` fires only on transitions. Returns an unsubscribe that stops the rAF loop.
export function watchSpeaking(
  analyser: AnalyserNode,
  cb: (speaking: boolean) => void,
  opts: SpeakingOpts = {},
): () => void {
  const threshold = opts.thresholdRms ?? LIMITS.speakingRmsThreshold;
  const sustainMs = opts.sustainMs ?? LIMITS.speakingSustainMs;
  const hangoverMs = opts.hangoverMs ?? LIMITS.speakingHangoverMs;
  const buf = new Float32Array(analyser.fftSize);
  let speaking = false;
  let aboveSince: number | null = null;
  let belowSince: number | null = null;

  const tick = (): void => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    opts.onLevel?.(normalizeVoiceLevel(rms, threshold));
    const now = performance.now();
    if (rms >= threshold) {
      belowSince = null;
      aboveSince ??= now;
      if (!speaking && now - aboveSince >= sustainMs) {
        speaking = true;
        cb(true);
      }
    } else {
      aboveSince = null;
      if (speaking) {
        belowSince ??= now;
        if (now - belowSince >= hangoverMs) {
          speaking = false;
          cb(false);
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  };

  let rafId = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(rafId);
    opts.onLevel?.(0);
  };
}
