import { authTransport } from "@/lib/authTransport";
import { platform } from "@/platform/types";
import type { AudioGraph } from "./audioGraph";

export type SoundboardPlaybackMode = "shared" | "local-preview" | "editor-preview";

export interface PlayableSound {
  id: string;
  trimStartMs: number;
  trimEndMs: number;
  gain: number;
}

interface ActivePlayback {
  cancelled: boolean;
  promise: Promise<void>;
}

// FR-36 soundboard playback. On a `sound.played` broadcast, each in-voice client fetches the mp3
// (Cache API-backed), decodes it PER play (no decoded-buffer cache — §7.4), and plays the
// [trimStart,trimEnd] slice through the graph's `sbGain` (never injected into WebRTC — A7). The class
// signature is frozen by S7.2; this step fills the body and adds `stopAll`.
export class SoundboardPlayer {
  private readonly graph: AudioGraph;
  private readonly fetchSound: (soundId: string) => Promise<ArrayBuffer>;
  private readonly activePlaybacks = new Map<string, ActivePlayback>();

  constructor(deps: { graph: AudioGraph; fetchSound: (soundId: string) => Promise<ArrayBuffer> }) {
    this.graph = deps.graph;
    this.fetchSound = deps.fetchSound;
  }

  async play(sound: PlayableSound, mode: SoundboardPlaybackMode = "shared"): Promise<void> {
    await this.playOnce(sound, mode, async () =>
      platform.isE2E ? null : await this.fetchSound(sound.id),
    );
  }

  async playBytes(
    bytes: ArrayBuffer,
    sound: PlayableSound,
    mode: SoundboardPlaybackMode,
    onStarted?: () => void,
  ): Promise<void> {
    await this.playOnce(sound, mode, async () => bytes, onStarted);
  }

  private async playOnce(
    sound: PlayableSound,
    mode: SoundboardPlaybackMode,
    loadBytes: () => Promise<ArrayBuffer | null>,
    onStarted?: () => void,
  ): Promise<void> {
    const key = `${mode}:${sound.id}`;
    const existing = this.activePlaybacks.get(key);
    if (existing !== undefined) {
      await existing.promise;
      return;
    }
    const playback: ActivePlayback = { cancelled: false, promise: Promise.resolve() };
    playback.promise = (async () => {
      try {
        const bytes = await loadBytes();
        if (playback.cancelled) return;
        await this.playBytesInternal(bytes, sound, mode, playback, onStarted);
      } finally {
        if (this.activePlaybacks.get(key) === playback) this.activePlaybacks.delete(key);
      }
    })();
    this.activePlaybacks.set(key, playback);
    await playback.promise;
  }

  private async playBytesInternal(
    bytes: ArrayBuffer | null,
    sound: PlayableSound,
    mode: SoundboardPlaybackMode,
    playback: ActivePlayback,
    onStarted?: () => void,
  ): Promise<void> {
    // §10 e2e: record the play instead of producing audible output (deterministic under fake media —
    // the FR-36 cross-client sync AC reads window.__tavernTestAudio.soundboardPlays). The array
    // identity is stable (S7.4 owns it); this is the SOLE consumer of the soundboardPlays field.
    if (platform.isE2E && typeof window !== "undefined") {
      if (playback.cancelled) return;
      // oxlint-disable-next-line no-underscore-dangle -- the pinned §10 e2e hook global window.__tavernTestAudio
      window.__tavernTestAudio?.soundboardPlays.push({
        soundId: sound.id,
        at: Date.now(),
        mode,
        trimStartMs: sound.trimStartMs,
        trimEndMs: sound.trimEndMs,
        gain: sound.gain,
      });
      onStarted?.();
      return;
    }
    if (bytes === null) throw new Error("Sound bytes are unavailable");
    const buffer = await this.graph.decode(bytes);
    if (playback.cancelled) return;
    await this.graph.playSoundboard(
      buffer,
      sound.trimStartMs,
      sound.trimEndMs,
      sound.gain,
      mode,
      sound.id,
      onStarted,
    );
  }

  // Cuts every live soundboard source (deafen-on and voice leave). Delegates to the graph, which owns
  // the live BufferSourceNodes (§7.3 one AudioContext).
  stopAll(): void {
    this.cancelPlaybacks((key) => key.startsWith("shared:"));
    this.graph.stopSoundboard();
  }

  stop(soundId: string): void {
    this.cancelPlayback(`shared:${soundId}`);
    this.graph.stopSoundboard(soundId);
  }

  stopPreview(soundId?: string): void {
    if (soundId === undefined) this.cancelPlaybacks((key) => !key.startsWith("shared:"));
    else this.cancelPlayback(`local-preview:${soundId}`);
    this.graph.stopSoundboardPreview(soundId);
  }

  private cancelPlayback(key: string): void {
    const playback = this.activePlaybacks.get(key);
    if (playback === undefined) return;
    playback.cancelled = true;
    this.activePlaybacks.delete(key);
  }

  private cancelPlaybacks(matches: (key: string) => boolean): void {
    for (const [key, playback] of this.activePlaybacks) {
      if (!matches(key)) continue;
      playback.cancelled = true;
      this.activePlaybacks.delete(key);
    }
  }
}

// The Cache API cache name for fetched soundboard mp3s (browser-managed eviction — no manual eviction).
export const SOUNDS_CACHE = "tavern-sounds";

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

// Builds the `fetchSound` closure for one server: derives the R2 key from serverId + soundId (§5.3
// `sounds/{serverId}/{soundId}.mp3`) and serves the bytes through the Cache API — a cache hit skips the
// network, a miss fetches (authed, membership-gated by the media route) and stores the response.
export function createSoundFetcher(serverId: string): (soundId: string) => Promise<ArrayBuffer> {
  return async (soundId: string): Promise<ArrayBuffer> => {
    const url = `${API_BASE}/api/media/sounds/${serverId}/${soundId}.mp3`;
    const cache = await caches.open(SOUNDS_CACHE);
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
    const headers = await authTransport.getAuthHeaders();
    const res = await fetch(url, { headers, credentials: "include" });
    if (!res.ok) throw new Error(`sound fetch failed: ${res.status}`);
    await cache.put(url, res.clone());
    return res.arrayBuffer();
  };
}
