export type UiSoundKind =
  | "chat.send"
  | "notification"
  | "stream.start"
  | "stream.stop"
  | "voice.join"
  | "voice.leave";

type ToneStep = {
  frequency: number;
  durationMs: number;
  delayMs: number;
  gain: number;
  type?: OscillatorType;
};

const PATTERNS: Record<UiSoundKind, ToneStep[]> = {
  "chat.send": [{ frequency: 920, durationMs: 42, delayMs: 0, gain: 0.045, type: "square" }],
  notification: [
    { frequency: 740, durationMs: 48, delayMs: 0, gain: 0.05, type: "sine" },
    { frequency: 980, durationMs: 68, delayMs: 72, gain: 0.055, type: "sine" },
  ],
  "stream.start": [
    { frequency: 540, durationMs: 58, delayMs: 0, gain: 0.04, type: "triangle" },
    { frequency: 720, durationMs: 76, delayMs: 78, gain: 0.045, type: "triangle" },
    { frequency: 980, durationMs: 92, delayMs: 170, gain: 0.05, type: "triangle" },
  ],
  "stream.stop": [
    { frequency: 980, durationMs: 72, delayMs: 0, gain: 0.045, type: "triangle" },
    { frequency: 720, durationMs: 72, delayMs: 82, gain: 0.04, type: "triangle" },
    { frequency: 520, durationMs: 96, delayMs: 160, gain: 0.038, type: "triangle" },
  ],
  "voice.join": [
    { frequency: 620, durationMs: 70, delayMs: 0, gain: 0.05, type: "sine" },
    { frequency: 840, durationMs: 110, delayMs: 86, gain: 0.055, type: "sine" },
  ],
  "voice.leave": [
    { frequency: 840, durationMs: 70, delayMs: 0, gain: 0.05, type: "sine" },
    { frequency: 520, durationMs: 120, delayMs: 90, gain: 0.045, type: "sine" },
  ],
};

let context: AudioContext | null = null;
let listenerCleanup: (() => void) | null = null;
let listenersWired = false;

function ensureContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
  if (context === null) context = new AudioContext();
  return context;
}

async function resumeContext(): Promise<void> {
  const ctx = ensureContext();
  if (ctx === null || ctx.state === "running") return;
  try {
    await ctx.resume();
  } catch {
    // Silent by design: autoplay policy or teardown can reject the resume request.
  }
}

function scheduleTone(ctx: AudioContext, step: ToneStep): void {
  const startAt = ctx.currentTime + step.delayMs / 1000;
  const endAt = startAt + step.durationMs / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = step.type ?? "sine";
  osc.frequency.setValueAtTime(step.frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(step.gain, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(endAt + 0.03);
}

function wireResumeOnGesture(): void {
  if (listenersWired || typeof window === "undefined") return;
  listenersWired = true;
  const onGesture = (): void => {
    void resumeContext();
  };
  const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
  for (const event of events) window.addEventListener(event, onGesture, true);
  listenerCleanup = () => {
    listenersWired = false;
    for (const event of events) window.removeEventListener(event, onGesture, true);
  };
}

export function primeUiSounds(): () => void {
  wireResumeOnGesture();
  void resumeContext();
  return () => {
    listenerCleanup?.();
    listenerCleanup = null;
  };
}

export function playUiSound(kind: UiSoundKind): void {
  const ctx = ensureContext();
  if (ctx === null) return;
  void resumeContext();
  for (const step of PATTERNS[kind]) scheduleTone(ctx, step);
}
