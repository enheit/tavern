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
  private readonly remotes = new Map<string, RemoteMic>();
  private readonly streams = new Map<string, StreamAudio>();
  private readonly userGains = new Map<string, number>();
  private readonly streamGains = new Map<string, number>();
  private soundboardGain = 1;

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

  async playSoundboard(buffer: AudioBuffer, trimStartMs: number, trimEndMs: number): Promise<void> {
    const ctx = this.requireCtx();
    if (!this.sbGain) throw new Error("AudioGraph not initialized");
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.sbGain);
    const offset = trimStartMs / 1000;
    const duration = (trimEndMs - trimStartMs) / 1000; // trim is metadata-only; slice at playback
    await new Promise<void>((resolve) => {
      src.addEventListener("ended", () => {
        resolve();
      });
      src.start(0, offset, duration);
    });
  }

  // The recording captures the call as heard: pre-deafen per-user gains + own mic + soundboard tap.
  mixForRecording(localMic: MediaStreamTrack): MediaStream {
    const ctx = this.requireCtx();
    const dest = ctx.createMediaStreamDestination();
    for (const r of this.remotes.values()) r.gain.connect(dest);
    if (this.sbGain) this.sbGain.connect(dest);
    ctx.createMediaStreamSource(new MediaStream([localMic])).connect(dest);
    return dest.stream;
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
