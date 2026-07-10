import { browserAudioPort } from "./ports";

// FR-34 client-side duration probe: decode an audio file and read its duration. Lives in the media
// layer (not a feature) so the AudioContext is created only via the S7.2 audio port — the engine is
// never touched directly from app/src/features. Resampling to 48 kHz leaves `duration` (a time, not
// a sample count) unchanged. Injectable seam callers stub in tests, so this rarely runs.
export async function decodeDurationMs(file: File): Promise<number> {
  const ctx = browserAudioPort.createContext({ sampleRate: 48000 });
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    return Math.round(buffer.duration * 1000);
  } finally {
    void ctx.close();
  }
}
