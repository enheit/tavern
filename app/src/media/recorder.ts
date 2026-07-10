import type { AudioGraph } from "./audioGraph";

// Interface pinned now (PLAN §7.2); the FR-25 mixer + MediaRecorder + chunked upload land in S9.3.
export interface RecorderChunkSink {
  onPart(partNumber: number, bytes: Uint8Array, isFinal: boolean): Promise<void>;
}

const NOT_IMPLEMENTED = "S9 not implemented";

export class VoiceRecorder {
  readonly active: boolean = false;
  private readonly graph: AudioGraph;

  constructor(deps: { graph: AudioGraph }) {
    this.graph = deps.graph;
  }

  start(localMic: MediaStreamTrack, sink: RecorderChunkSink): void {
    void this.graph;
    void localMic;
    void sink;
    throw new Error(NOT_IMPLEMENTED);
  }

  stop(): Promise<{ durationMs: number }> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
