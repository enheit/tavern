import { vi } from "vitest";

// Minimal MediaStreamTrack / MediaStream test doubles. Only the members the engine touches are
// present; the cast is a test double (PLAN §9.1 allows casts for test doubles).
export function fakeTrack(kind: "audio" | "video" = "audio"): MediaStreamTrack {
  return {
    kind,
    enabled: true,
    id: `${kind}-${Math.random().toString(36).slice(2)}`,
    stop: vi.fn(),
    applyConstraints: vi.fn(async () => undefined),
  } as unknown as MediaStreamTrack;
}

export function fakeStream(over?: {
  audio?: MediaStreamTrack[];
  video?: MediaStreamTrack[];
}): MediaStream {
  const audio = over?.audio ?? [];
  const video = over?.video ?? [];
  return {
    id: `stream-${Math.random().toString(36).slice(2)}`,
    getAudioTracks: () => audio,
    getVideoTracks: () => video,
    getTracks: () => [...audio, ...video],
  } as unknown as MediaStream;
}
