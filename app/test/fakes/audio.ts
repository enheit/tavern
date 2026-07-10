// Records the WebAudio node graph as an inspectable tree: every node keeps the list of nodes it was
// connected to, and the context keeps each created node in creation order. Handed to the engine as an
// AudioPort; tests read the recorded fakes directly.

export class FakeAudioNode {
  readonly kind: string;
  readonly outputs: FakeAudioNode[] = [];
  disconnected = false;

  constructor(kind: string) {
    this.kind = kind;
  }

  connect(dest: FakeAudioNode): FakeAudioNode {
    this.outputs.push(dest);
    return dest;
  }

  // No arg → drop every output (matches WebAudio `disconnect()`); with a target → drop only that one
  // edge (WebAudio `disconnect(destinationNode)`), leaving other outputs intact (FR-25 mix release).
  disconnect(dest?: FakeAudioNode): void {
    if (dest === undefined) {
      this.disconnected = true;
      this.outputs.length = 0;
      return;
    }
    const idx = this.outputs.indexOf(dest);
    if (idx !== -1) this.outputs.splice(idx, 1);
  }
}

class FakeAudioParam {
  value = 1;
}

export class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();

  constructor() {
    super("gain");
  }
}

export class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 2048;
  frameValue = 0;

  constructor() {
    super("analyser");
  }

  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(this.frameValue);
  }
}

export class FakeMediaStreamSourceNode extends FakeAudioNode {
  readonly stream: unknown;

  constructor(stream: unknown) {
    super("source");
    this.stream = stream;
  }
}

export class FakeAudioBufferSourceNode extends FakeAudioNode {
  buffer: AudioBuffer | null = null;
  readonly startArgs: number[][] = [];
  stopped = 0;
  private readonly endedListeners = new Set<() => void>();

  constructor() {
    super("bufferSource");
  }

  addEventListener(type: string, cb: () => void): void {
    if (type === "ended") this.endedListeners.add(cb);
  }

  start(when = 0, offset = 0, duration = 0): void {
    this.startArgs.push([when, offset, duration]);
    // Real sources end asynchronously — schedule `ended` on a microtask so a synchronous
    // stopSoundboard() still sees the source live in the graph before playSoundboard resolves.
    queueMicrotask(() => this.fireEnded());
  }

  stop(): void {
    this.stopped += 1;
    this.fireEnded(); // stopping a source dispatches `ended` (real behavior)
  }

  private fireEnded(): void {
    for (const cb of this.endedListeners) cb();
  }
}

export class FakeMediaStreamDestinationNode extends FakeAudioNode {
  readonly stream: MediaStream;

  constructor(stream: MediaStream) {
    super("dest");
    this.stream = stream;
  }
}

export class FakeAudioDestinationNode extends FakeAudioNode {
  constructor() {
    super("destination");
  }
}

export class FakeAudioElement {
  srcObject: MediaStream | null = null;
  muted = false;
  played = false;
  paused = false;

  play(): Promise<void> {
    this.played = true;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }
}

export class FakeAudioContext {
  state: AudioContextState = "suspended";
  sinkId: string | null = null;
  closed = false;
  resumed = false;
  readonly destination = new FakeAudioDestinationNode();
  readonly gains: FakeGainNode[] = [];
  readonly sources: FakeMediaStreamSourceNode[] = [];
  readonly analysers: FakeAnalyserNode[] = [];
  readonly bufferSources: FakeAudioBufferSourceNode[] = [];
  readonly destinations: FakeMediaStreamDestinationNode[] = [];
  readonly decoded: ArrayBuffer[] = [];

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createAnalyser(): FakeAnalyserNode {
    const node = new FakeAnalyserNode();
    this.analysers.push(node);
    return node;
  }

  createMediaStreamSource(stream: unknown): FakeMediaStreamSourceNode {
    const node = new FakeMediaStreamSourceNode(stream);
    this.sources.push(node);
    return node;
  }

  createBufferSource(): FakeAudioBufferSourceNode {
    const node = new FakeAudioBufferSourceNode();
    this.bufferSources.push(node);
    return node;
  }

  createMediaStreamDestination(): FakeMediaStreamDestinationNode {
    const marker = { id: `dest-${this.destinations.length}` };
    const node = new FakeMediaStreamDestinationNode(marker as unknown as MediaStream);
    this.destinations.push(node);
    return node;
  }

  decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer> {
    this.decoded.push(bytes);
    return Promise.resolve({
      duration: 1,
      length: 48000,
      numberOfChannels: 2,
      sampleRate: 48000,
    } as unknown as AudioBuffer);
  }

  resume(): Promise<void> {
    this.resumed = true;
    this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }

  setSinkId(sinkId: string): Promise<void> {
    this.sinkId = sinkId;
    return Promise.resolve();
  }
}

export class FakeAudioPort {
  readonly contexts: FakeAudioContext[] = [];
  readonly elements: FakeAudioElement[] = [];

  createContext(opts: { sampleRate: 48000 }): AudioContext {
    void opts;
    const ctx = new FakeAudioContext();
    this.contexts.push(ctx);
    return ctx as unknown as AudioContext;
  }

  createAudioElement(): HTMLAudioElement {
    const el = new FakeAudioElement();
    this.elements.push(el);
    return el as unknown as HTMLAudioElement;
  }

  last(): FakeAudioContext {
    const ctx = this.contexts.at(-1);
    if (!ctx) throw new Error("no audio context created");
    return ctx;
  }
}
