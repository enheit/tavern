import type { AudioGraph } from "./audioGraph";

// Interface pinned now (PLAN §7.2); the FR-36 fetch/decode/trim/play body lands in S9.2.
export class SoundboardPlayer {
  private readonly graph: AudioGraph;
  private readonly fetchSound: (soundId: string) => Promise<ArrayBuffer>;

  constructor(deps: { graph: AudioGraph; fetchSound: (soundId: string) => Promise<ArrayBuffer> }) {
    this.graph = deps.graph;
    this.fetchSound = deps.fetchSound;
  }

  play(sound: { id: string; trimStartMs: number; trimEndMs: number }): Promise<void> {
    void this.graph;
    void this.fetchSound;
    void sound;
    throw new Error("S9 not implemented");
  }
}
