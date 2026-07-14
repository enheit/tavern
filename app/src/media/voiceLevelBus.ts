// The voice renderer needs a fresh amplitude sample every animation frame, but React and Zustand
// should continue to update only when the coarse speaking state changes. This tiny in-memory bus is
// owned by the voice session: the level meter writes normalized 0..1 values and the WebGL stage reads
// them from its render loop without causing component renders.
const levels = new Map<string, number>();

export function setVoiceLevel(userId: string, level: number): void {
  if (!Number.isFinite(level)) throw new TypeError("voice level must be finite");
  const normalized = Math.min(1, Math.max(0, level));
  if (normalized === 0) levels.delete(userId);
  else levels.set(userId, normalized);
}

export function readVoiceLevel(userId: string): number {
  return levels.get(userId) ?? 0;
}

export function clearVoiceLevel(userId: string): void {
  levels.delete(userId);
}

export function clearVoiceLevels(): void {
  levels.clear();
}
