// Track-name grammar (PLAN §7.1): mic:{userId} · screen:{userId}:{n} · screenAudio:{userId}:{n} ·
// cam:{userId}. The worker (S7.1) validates the same grammar independently; this is the client-side
// constructor. `n` = the per-PublishSession monotonic share counter (starts at 1) so a stop/start is
// a fresh name and stale subscriptions never race.

export function micTrackName(userId: string): string {
  return `mic:${userId}`;
}

export function camTrackName(userId: string): string {
  return `cam:${userId}`;
}

export function screenTrackName(userId: string, n: number): string {
  return `screen:${userId}:${n}`;
}

export function screenAudioTrackName(userId: string, n: number): string {
  return `screenAudio:${userId}:${n}`;
}
