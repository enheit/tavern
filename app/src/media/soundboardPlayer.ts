import { authTransport } from "@/lib/authTransport";
import { platform } from "@/platform/types";
import type { AudioGraph } from "./audioGraph";

// FR-36 soundboard playback. On a `sound.played` broadcast, each in-voice client fetches the mp3
// (Cache API-backed), decodes it PER play (no decoded-buffer cache — §7.4), and plays the
// [trimStart,trimEnd] slice through the graph's `sbGain` (never injected into WebRTC — A7). The class
// signature is frozen by S7.2; this step fills the body and adds `stopAll`.
export class SoundboardPlayer {
  private readonly graph: AudioGraph;
  private readonly fetchSound: (soundId: string) => Promise<ArrayBuffer>;

  constructor(deps: { graph: AudioGraph; fetchSound: (soundId: string) => Promise<ArrayBuffer> }) {
    this.graph = deps.graph;
    this.fetchSound = deps.fetchSound;
  }

  async play(sound: { id: string; trimStartMs: number; trimEndMs: number }): Promise<void> {
    // §10 e2e: record the play instead of producing audible output (deterministic under fake media —
    // the FR-36 cross-client sync AC reads window.__tavernTestAudio.soundboardPlays). The array
    // identity is stable (S7.4 owns it); this is the SOLE consumer of the soundboardPlays field.
    if (platform.isE2E && typeof window !== "undefined") {
      // oxlint-disable-next-line no-underscore-dangle -- the pinned §10 e2e hook global window.__tavernTestAudio
      window.__tavernTestAudio?.soundboardPlays.push({ soundId: sound.id, at: Date.now() });
      return;
    }
    const bytes = await this.fetchSound(sound.id);
    const buffer = await this.graph.decode(bytes);
    // Concurrent/overlapping plays are allowed — the graph tracks each live source node.
    await this.graph.playSoundboard(buffer, sound.trimStartMs, sound.trimEndMs);
  }

  // Cuts every live soundboard source (deafen-on and voice leave). Delegates to the graph, which owns
  // the live BufferSourceNodes (§7.3 one AudioContext).
  stopAll(): void {
    this.graph.stopSoundboard();
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
