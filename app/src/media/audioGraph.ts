import type { AudioPort } from "./ports";

declare global {
  interface AudioContext {
    // Chromium 110+ output routing (PLAN §7.3); absent from TS 7.0.2 lib.dom.
    setSinkId(sinkId: string): Promise<void>;
  }
}

interface RemoteMic {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  element: HTMLAudioElement;
}

interface StreamAudio {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  element: HTMLAudioElement;
}

// One AudioContext for the whole app (PLAN §7.3):
//   remote mic tracks ─► userGain[uid] ─┐
//   stream audio ──────► streamGain[t] ─┼─► deafenGain ─► masterGain ─► destination (chosen sink)
//   soundboard buffers ► sbGain ────────┘
//   local mic ─► Analyser (speaking meter, never routed to output)
// Sliders 0..200% map to gain 0..2 (GainNode, not element.volume which caps at 1.0). Deafen zeroes
// deafenGain only; per-user gains and the pre-deafen recording tap are untouched.
export class AudioGraph {
  private readonly port: AudioPort;
  private ctx: AudioContext | null = null;
  private deafenGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private sbGain: GainNode | null = null;
  private localSource: MediaStreamAudioSourceNode | null = null;
  private localAnalyser: AnalyserNode | null = null;
  // FR-25 recording tap: the nodes fanned into the recording destination (per-user gains + sbGain +
  // the recorder's own mic source), tracked so `releaseRecordingMix` disconnects exactly them from the
  // recording dest WITHOUT touching their live connection to deafenGain.
  private recordingDest: MediaStreamAudioDestinationNode | null = null;
  private recordingMicSource: MediaStreamAudioSourceNode | null = null;
  private readonly recordingTaps: AudioNode[] = [];
  private readonly remotes = new Map<string, RemoteMic>();
  private readonly streams = new Map<string, StreamAudio>();
  private readonly userGains = new Map<string, number>();
  private readonly streamGains = new Map<string, number>();
  private soundboardGain = 1;
  // Live soundboard BufferSourceNodes (FR-36: overlapping/concurrent plays are allowed — Discord-style).
  // `stopSoundboard` cuts them all (deafen-on, voice leave); each source drops itself on `ended`.
  private readonly liveSources = new Set<AudioBufferSourceNode>();

  constructor(port: AudioPort) {
    this.port = port;
  }

  async init(sinkId?: string): Promise<void> {
    const ctx = this.port.createContext({ sampleRate: 48000 });
    const master = ctx.createGain();
    const deafen = ctx.createGain();
    const sb = ctx.createGain();
    sb.gain.value = this.soundboardGain;
    deafen.connect(master);
    master.connect(ctx.destination);
    sb.connect(deafen);
    this.ctx = ctx;
    this.masterGain = master;
    this.deafenGain = deafen;
    this.sbGain = sb;
    if (sinkId) await ctx.setSinkId(sinkId);
  }

  private requireCtx(): AudioContext {
    if (!this.ctx) throw new Error("AudioGraph not initialized");
    return this.ctx;
  }

  private requireDeafen(): GainNode {
    if (!this.deafenGain) throw new Error("AudioGraph not initialized");
    return this.deafenGain;
  }

  // MUST be called from the join-click gesture — the autoplay policy leaves the context suspended,
  // and a suspended context = silent meters / recording / soundboard.
  async resume(): Promise<void> {
    await this.requireCtx().resume();
  }

  attachRemoteMic(userId: string, stream: MediaStream): void {
    const ctx = this.requireCtx();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = this.userGains.get(userId) ?? 1;
    const analyser = ctx.createAnalyser();
    source.connect(gain);
    gain.connect(this.requireDeafen());
    source.connect(analyser); // pre-gain tap: the speaking ring is independent of local volume/mute
    const element = this.mutedElement(stream); // crbug 40094084 flow-starter
    this.remotes.set(userId, { source, gain, analyser, element });
  }

  detachRemoteMic(userId: string): void {
    const r = this.remotes.get(userId);
    if (!r) return;
    r.source.disconnect();
    r.gain.disconnect();
    r.analyser.disconnect();
    this.stopElement(r.element);
    this.remotes.delete(userId);
  }

  attachStreamAudio(trackName: string, stream: MediaStream): void {
    const ctx = this.requireCtx();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = this.streamGains.get(trackName) ?? 1;
    source.connect(gain);
    gain.connect(this.requireDeafen());
    const element = this.mutedElement(stream);
    this.streams.set(trackName, { source, gain, element });
  }

  detachStreamAudio(trackName: string): void {
    const s = this.streams.get(trackName);
    if (!s) return;
    s.source.disconnect();
    s.gain.disconnect();
    this.stopElement(s.element);
    this.streams.delete(trackName);
  }

  attachLocalMic(track: MediaStreamTrack): void {
    const ctx = this.requireCtx();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    source.connect(analyser); // analyser only — never routed to output
    this.localSource = source;
    this.localAnalyser = analyser;
  }

  setUserGain(userId: string, gain: number): void {
    this.userGains.set(userId, gain);
    const r = this.remotes.get(userId);
    if (r) r.gain.gain.value = gain;
  }

  setStreamGain(trackName: string, gain: number): void {
    this.streamGains.set(trackName, gain);
    const s = this.streams.get(trackName);
    if (s) s.gain.gain.value = gain;
  }

  setSoundboardGain(gain: number): void {
    this.soundboardGain = gain;
    if (this.sbGain) this.sbGain.gain.value = gain;
  }

  setDeafened(deafened: boolean): void {
    this.requireDeafen().gain.value = deafened ? 0 : 1;
  }

  async setSink(deviceId: string): Promise<void> {
    await this.requireCtx().setSinkId(deviceId);
  }

  // Decodes fetched mp3 bytes into an AudioBuffer through the single app context (§7.3). The soundboard
  // player decodes PER play and releases the buffer after (§7.4 — a 5-min stereo buffer ≈ 110 MB, so
  // decoded buffers are never cached). This is the only decode home — features never build a context.
  async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return this.requireCtx().decodeAudioData(bytes);
  }

  async playSoundboard(buffer: AudioBuffer, trimStartMs: number, trimEndMs: number): Promise<void> {
    const ctx = this.requireCtx();
    if (!this.sbGain) throw new Error("AudioGraph not initialized");
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.sbGain);
    this.liveSources.add(src);
    const offset = trimStartMs / 1000;
    const duration = (trimEndMs - trimStartMs) / 1000; // trim is metadata-only; slice at playback
    await new Promise<void>((resolve) => {
      src.addEventListener("ended", () => {
        this.liveSources.delete(src);
        resolve();
      });
      src.start(0, offset, duration);
    });
  }

  // Cuts every live soundboard source (FR-36: deafen stops in-flight soundboard audio; voice leave
  // stops it too). A stopped source fires `ended`, which also removes it from the set (harmless double).
  stopSoundboard(): void {
    for (const src of this.liveSources) {
      try {
        src.stop();
      } catch {
        // Source already stopped/ended — it is being cleared anyway.
      }
    }
    this.liveSources.clear();
  }

  // The recording captures the call as heard: pre-deafen per-user gains + own mic + soundboard tap.
  // A snapshot at start (late joiners are not re-tapped — pinned, §7.4). `releaseRecordingMix` undoes
  // exactly these connections on stop/error.
  mixForRecording(localMic: MediaStreamTrack): MediaStream {
    const ctx = this.requireCtx();
    this.releaseRecordingMix(); // idempotent guard: never leave a prior tap connected
    const dest = ctx.createMediaStreamDestination();
    for (const r of this.remotes.values()) {
      r.gain.connect(dest);
      this.recordingTaps.push(r.gain);
    }
    if (this.sbGain) {
      this.sbGain.connect(dest);
      this.recordingTaps.push(this.sbGain);
    }
    const micSource = ctx.createMediaStreamSource(new MediaStream([localMic]));
    micSource.connect(dest);
    this.recordingMicSource = micSource;
    this.recordingDest = dest;
    return dest.stream;
  }

  // Tears down the recording tap (FR-25 stop/error): disconnect every tapped gain from the recording
  // dest (their live path to deafenGain is untouched) + the recorder's own mic source. Idempotent.
  releaseRecordingMix(): void {
    const dest = this.recordingDest;
    if (dest !== null) {
      for (const tap of this.recordingTaps) tap.disconnect(dest);
    }
    this.recordingMicSource?.disconnect();
    this.recordingTaps.length = 0;
    this.recordingMicSource = null;
    this.recordingDest = null;
  }

  // FR-22 WASM noise-suppression modes run their AudioWorklet in the ONE app context (§7.3 — the
  // mic pipeline never builds a second AudioContext). Null before init/after close; the capture
  // layer then falls back to raw capture.
  micProcessingContext(): AudioContext | null {
    return this.ctx;
  }

  getUserAnalyser(userId: string): AnalyserNode | null {
    return this.remotes.get(userId)?.analyser ?? null;
  }

  getLocalAnalyser(): AnalyserNode | null {
    return this.localAnalyser;
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    this.remotes.clear();
    this.streams.clear();
    this.localSource = null;
    this.localAnalyser = null;
    this.ctx = null;
    if (ctx) await ctx.close();
  }

  private mutedElement(stream: MediaStream): HTMLAudioElement {
    const el = this.port.createAudioElement();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => undefined); // autoplay of a muted element is allowed; ignore failures
    return el;
  }

  private stopElement(el: HTMLAudioElement): void {
    el.pause();
    el.srcObject = null;
  }
}
