// The browser media engine (S7): the same §1 Engine⇄UI surface the Rust engine
// exposes through Tauri, implemented on browser WebRTC against the same Worker
// `/api/rtc/*` signaling. One PeerConnection for voice (mic publish + auto-pulled
// remote mics, mirroring crates/engine/src/engine.rs), plus one dedicated
// PeerConnection per video watch (the browser flavor of the str0m watch leg —
// the Worker already keys those to separate SFU sessions, S5.4).
//
// Events go through the same funnel the Tauri bridge feeds (events.ts):
//   engine://state  {voice, err?}          on every transition
//   engine://levels [{userId, rms}] @10 Hz (rms 0–1; self is userId "")
//   engine://stats  {json}          @1 Hz  (same fields as engine.rs stats_json)
import { emitEngineEvent } from './events';
import type { TrackInfo } from './protocol/TrackInfo';
import type { ScreenSource, WebcamDevice } from './engine';
import { encodingsFor, planScreen, planWebcam, simulcast, type EncodingPlan } from './plan';

const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
// S6.1 parity: 5 recovery windows × 5 s before reconnect_failed.
const RECONNECT_WINDOWS = 5;
const RECONNECT_WINDOW_MS = 5_000;
const TRACK_TIMEOUT_MS = 5_000;

// ---- signaling (port of crates/engine/src/signaling.rs) ----------------------

interface PublishTrack {
  trackName: string;
  kind: 'mic' | 'screen' | 'webcam';
  mid: string;
  width: number;
  height: number;
  fps: number;
  simulcast: boolean;
}

class Signaling {
  constructor(
    private apiBase: string,
    private token: string,
  ) {}

  private async post(op: string, body: unknown): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase.replace(/\/+$/, '')}/api/rtc/${op}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`signaling transport: ${String(e)}`);
    }
    const json = (await res.json().catch(() => null)) as Record<string, any> | null;
    // Same message shape as the Rust SignalError Display, so UI error text matches.
    if (!res.ok) throw new Error(`signaling http ${res.status} (${json?.code ?? '-'})`);
    return json ?? {};
  }

  private static sfuSdp(v: Record<string, any>): string {
    const sdp = v?.sfu?.sessionDescription?.sdp;
    if (typeof sdp !== 'string') throw new Error('signaling malformed: no sdp');
    return sdp;
  }

  private static requiresReneg(v: Record<string, any>): boolean {
    return v?.sfu?.requiresImmediateRenegotiation === true;
  }

  async session(channelId: string): Promise<void> {
    await this.post('session', { channelId });
  }

  async publish(channelId: string, t: PublishTrack, offerSdp: string): Promise<{ sdp: string; requiresReneg: boolean }> {
    const v = await this.post('publish', {
      channelId,
      trackName: t.trackName,
      kind: t.kind,
      width: t.width,
      height: t.height,
      fps: t.fps,
      simulcast: t.simulcast,
      sfu: {
        sessionDescription: { sdp: offerSdp, type: 'offer' },
        tracks: [{ location: 'local', mid: t.mid, trackName: t.trackName }],
      },
    });
    return { sdp: Signaling.sfuSdp(v), requiresReneg: Signaling.requiresReneg(v) };
  }

  async subscribe(
    channelId: string,
    ownerId: string,
    trackName: string,
    layer: 'l' | 'h',
  ): Promise<{ sdp: string; requiresReneg: boolean }> {
    const v = await this.post('subscribe', { channelId, ownerId, trackName, layer });
    return { sdp: Signaling.sfuSdp(v), requiresReneg: Signaling.requiresReneg(v) };
  }

  async renegotiate(channelId: string, answerSdp: string): Promise<void> {
    await this.post('renegotiate', { channelId, sfu: { sessionDescription: { sdp: answerSdp, type: 'answer' } } });
  }

  /** Video pull answers route to the per-watch SFU session via {ownerId, trackName} (S5.4). */
  async renegotiateWatch(channelId: string, ownerId: string, trackName: string, answerSdp: string): Promise<void> {
    await this.post('renegotiate', {
      channelId,
      ownerId,
      trackName,
      sfu: { sessionDescription: { sdp: answerSdp, type: 'answer' } },
    });
  }

  async unsubscribe(channelId: string, ownerId: string, trackName: string): Promise<void> {
    await this.post('unsubscribe', { channelId, ownerId, trackName });
  }

  async unpublish(channelId: string, trackName: string): Promise<void> {
    await this.post('unpublish', { channelId, trackName });
  }

  async close(channelId: string): Promise<void> {
    await this.post('close', { channelId });
  }
}

// ---- engine state -------------------------------------------------------------

interface RemoteAudio {
  ownerId: string;
  trackName: string;
  el: HTMLAudioElement; // drives the remote track (WebAudio won't pull a bare WebRTC stream)
  src: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
}

interface ActiveVideo {
  kind: 'screen' | 'webcam';
  trackName: string;
  stream: MediaStream;
}

interface Watch {
  ownerId: string;
  trackName: string;
  layer: 'l' | 'h';
  pc: RTCPeerConnection;
  stream: MediaStream | null;
}

type VoiceLabel = 'idle' | 'connecting' | 'connected' | 'reconnecting';

const watchKey = (ownerId: string, trackName: string) => `${ownerId}/${trackName}`;

class WebEngine {
  private sig: Signaling | null = null;
  private voice: VoiceLabel = 'idle';
  private channelId: string | null = null;
  private pc: RTCPeerConnection | null = null;
  private micStream: MediaStream | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private muted = false;
  private deafened = false;
  private gains = new Map<string, number>();
  private published: { kind: string; trackName: string }[] = [];
  private roster: TrackInfo[] = [];
  private subs = new Map<string, RemoteAudio>();
  private videos: ActiveVideo[] = [];
  private watches = new Map<string, Watch>();
  // SFU-added audio tracks in arrival order; subscribes are serialized so order
  // pairs them to their pull (same ponytail as engine.rs establish()).
  private trackQueue: MediaStreamTrack[] = [];
  private trackWaiters: ((t: MediaStreamTrack) => void)[] = [];
  private syncChain: Promise<void> = Promise.resolve();
  private levelsTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private reconnecting = false;
  private epoch = 0; // bumped on leave; stale async work checks it

  configure(apiBase: string, token: string): void {
    this.sig = new Signaling(apiBase, token);
  }

  private emitState(err?: string): void {
    emitEngineEvent('engine://state', err ? { voice: this.voice, err } : { voice: this.voice });
  }

  private signaling(): Signaling {
    if (!this.sig) throw new Error('engine not configured');
    return this.sig;
  }

  // ---- voice -------------------------------------------------------------------

  async voiceJoin(channelId: string): Promise<{ trackName: string }> {
    const sig = this.signaling();
    if (this.voice !== 'idle') throw new Error('already in voice');
    this.voice = 'connecting';
    this.channelId = channelId;
    this.emitState();
    try {
      const trackName = await this.establish(sig, channelId);
      this.voice = 'connected';
      this.emitState();
      this.syncSubscriptions();
      return { trackName };
    } catch (e) {
      await this.teardown();
      void sig.close(channelId).catch(() => {});
      this.voice = 'idle';
      this.channelId = null;
      this.emitState();
      throw e;
    }
  }

  private async establish(sig: Signaling, channelId: string): Promise<string> {
    await sig.session(channelId);

    // Echo cancellation / noise suppression / AGC: the browser's APM — the same
    // processing the desktop engine gets from libwebrtc's APM.
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const micTrack = this.micStream.getAudioTracks()[0];

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    pc.ontrack = (ev) => {
      if (ev.track.kind !== 'audio') return;
      const w = this.trackWaiters.shift();
      if (w) w(ev.track);
      else this.trackQueue.push(ev.track);
    };
    this.installReconnect(pc, this.epoch);

    const trackName = `mic-${crypto.randomUUID()}`;
    const tvr = pc.addTransceiver(micTrack, { direction: 'sendonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!tvr.mid) throw new Error('no mic mid');
    const answer = await sig.publish(
      channelId,
      { trackName, kind: 'mic', mid: tvr.mid, width: 0, height: 0, fps: 0, simulcast: false },
      offer.sdp!,
    );
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

    // Audio graph: remote mixes route src → per-user gain → master (deafen) → out;
    // analysers tap pre-gain, matching the desktop's pre-mix RMS.
    this.ctx = new AudioContext();
    void this.ctx.resume().catch(() => {});
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.masterGain.gain.value = this.deafened ? 0 : 1;
    this.micAnalyser = this.ctx.createAnalyser();
    this.ctx.createMediaStreamSource(this.micStream).connect(this.micAnalyser);

    this.applyMicEnabled();
    this.startLevels();
    this.startStats(pc, this.epoch);
    this.published = [{ kind: 'mic', trackName }];
    return trackName;
  }

  async voiceLeave(): Promise<void> {
    if (this.voice === 'idle') return;
    const channelId = this.channelId;
    await this.teardown();
    this.voice = 'idle';
    this.channelId = null;
    if (channelId) await this.signaling().close(channelId).catch(() => {});
    this.emitState();
  }

  private async teardown(): Promise<void> {
    this.epoch += 1;
    if (this.levelsTimer) clearInterval(this.levelsTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.levelsTimer = this.statsTimer = null;
    for (const w of this.watches.values()) w.pc.close();
    this.watches.clear();
    for (const v of this.videos) for (const t of v.stream.getTracks()) t.stop();
    this.videos = [];
    for (const r of this.subs.values()) this.dropRemoteAudio(r);
    this.subs.clear();
    this.trackQueue = [];
    this.trackWaiters = [];
    this.published = [];
    this.pc?.close();
    this.pc = null;
    if (this.micStream) for (const t of this.micStream.getTracks()) t.stop();
    this.micStream = null;
    this.micAnalyser = null;
    this.masterGain = null;
    this.reconnecting = false;
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  private dropRemoteAudio(r: RemoteAudio): void {
    r.el.pause();
    r.el.srcObject = null;
    try {
      r.src.disconnect();
      r.gain.disconnect();
      r.analyser.disconnect();
    } catch {
      // context already closed
    }
  }

  setMicMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMicEnabled();
  }

  /** Deafen silences all output AND suppresses the mic; `muted` is never clobbered (§1). */
  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    if (this.masterGain) this.masterGain.gain.value = deafened ? 0 : 1;
    this.applyMicEnabled();
  }

  private applyMicEnabled(): void {
    const track = this.micStream?.getAudioTracks()[0];
    if (track) track.enabled = !(this.muted || this.deafened);
  }

  setUserGain(userId: string, gain: number): void {
    const g = Math.min(2, Math.max(0, gain));
    this.gains.set(userId, g);
    for (const r of this.subs.values()) if (r.ownerId === userId) r.gain.gain.value = g;
  }

  // ---- roster → mic subscriptions (port of engine.rs sync_subscriptions) --------

  setRemoteTracks(tracks: TrackInfo[]): void {
    this.roster = tracks;
    this.syncSubscriptions();
  }

  private syncSubscriptions(): void {
    // Serialized: ontrack pairing relies on one subscribe in flight at a time.
    this.syncChain = this.syncChain.then(() => this.syncOnce()).catch(() => {});
  }

  private async syncOnce(): Promise<void> {
    if (this.voice !== 'connected' && this.voice !== 'connecting') return;
    const channelId = this.channelId;
    const pc = this.pc;
    if (!channelId || !pc) return;
    const sig = this.signaling();

    const own = new Set(this.published.map((p) => p.trackName));
    const want = new Map(
      this.roster
        .filter((t) => t.kind === 'mic' && !own.has(t.trackName))
        .map((t) => [watchKey(t.ownerId, t.trackName), t]),
    );
    for (const [key, t] of want) {
      if (this.subs.has(key)) continue;
      try {
        await this.subscribeMic(sig, channelId, pc, t);
      } catch (e) {
        console.warn('[engine.web] mic subscribe failed:', e);
      }
    }
    for (const [key, r] of [...this.subs]) {
      if (want.has(key)) continue;
      this.subs.delete(key);
      this.dropRemoteAudio(r);
      await sig.unsubscribe(channelId, r.ownerId, r.trackName).catch(() => {});
    }
  }

  private async subscribeMic(sig: Signaling, channelId: string, pc: RTCPeerConnection, t: TrackInfo): Promise<void> {
    // Mic tracks are single-encoding; layer "h" is ignored server-side.
    const offer = await sig.subscribe(channelId, t.ownerId, t.trackName, 'h');
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (offer.requiresReneg) await sig.renegotiate(channelId, answer.sdp!);

    const track = await this.nextTrack();
    if (!this.ctx || !this.masterGain) return; // torn down mid-subscribe
    const stream = new MediaStream([track]);
    // Chrome quirk: a WebRTC stream must feed a media element before WebAudio sees data.
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => {});
    const src = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    gain.gain.value = this.gains.get(t.ownerId) ?? 1;
    const analyser = this.ctx.createAnalyser();
    src.connect(analyser);
    src.connect(gain);
    gain.connect(this.masterGain);
    this.subs.set(watchKey(t.ownerId, t.trackName), {
      ownerId: t.ownerId,
      trackName: t.trackName,
      el,
      src,
      gain,
      analyser,
    });
  }

  private nextTrack(): Promise<MediaStreamTrack> {
    const q = this.trackQueue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.trackWaiters.indexOf(waiter);
        if (i >= 0) this.trackWaiters.splice(i, 1);
        reject(new Error('no remote track within 5s'));
      }, TRACK_TIMEOUT_MS);
      const waiter = (t: MediaStreamTrack) => {
        clearTimeout(timer);
        resolve(t);
      };
      this.trackWaiters.push(waiter);
    });
  }

  // ---- screen share / webcam -----------------------------------------------------

  screenSources(): ScreenSource[] {
    // The browser owns the picker (getDisplayMedia) — one pseudo-source keeps the
    // ShareDialog flow identical; the real choice happens in the browser prompt.
    return [{ id: 'browser', name: 'Screen or window (browser will ask)', kind: 'screen' }];
  }

  async webcamList(): Promise<WebcamDevice[]> {
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === 'videoinput' && d.label)) {
      // Labels are hidden until a camera permission is granted — prompt once.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        for (const t of probe.getTracks()) t.stop();
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        // denied — fall through to whatever enumerate returned
      }
    }
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ id: d.deviceId, name: d.label || `Camera ${i + 1}` }));
  }

  async screenShareStart(_sourceId: string, width: number, height: number, fps: number): Promise<{ trackName: string }> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: fps || 30 },
      audio: false, // §1 parity: shares are video-only (mic is the only audio track)
    });
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    // Same sizing rule as the desktop engine: plan from the REAL captured dims.
    const plan = planScreen(height, fps || 30, s.width ?? width ?? 1280, s.height ?? height ?? 720);
    return this.publishVideo('screen', stream, plan);
  }

  async screenShareStop(): Promise<void> {
    await this.stopVideo('screen');
  }

  async webcamStart(deviceId: string, width: number, height: number, fps: number): Promise<{ trackName: string }> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps },
      },
    });
    return this.publishVideo('webcam', stream, planWebcam(width, height, fps));
  }

  async webcamStop(): Promise<void> {
    await this.stopVideo('webcam');
  }

  private async publishVideo(kind: 'screen' | 'webcam', stream: MediaStream, plan: EncodingPlan): Promise<{ trackName: string }> {
    const stop = () => {
      for (const t of stream.getTracks()) t.stop();
    };
    const sig = this.signaling();
    const channelId = this.channelId;
    const pc = this.pc;
    if (this.voice !== 'connected' || !channelId || !pc) {
      stop();
      throw new Error('not in voice');
    }
    if (this.videos.some((v) => v.kind === kind)) {
      stop();
      throw new Error('already sharing');
    }
    const track = stream.getVideoTracks()[0];
    try {
      // Capture at the plan's h layer (the encoder-downscale the desktop does natively).
      await track.applyConstraints({
        width: plan.h.width,
        height: plan.h.height,
        frameRate: plan.h.fps,
      });
    } catch {
      // constraints are best-effort; the encodings still cap bitrate/fps
    }
    try {
      const trackName = `${kind}-${crypto.randomUUID()}`;
      const tvr = pc.addTransceiver(track, { direction: 'sendonly', sendEncodings: encodingsFor(plan) });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!tvr.mid) throw new Error('no video mid');
      const answer = await sig.publish(
        channelId,
        {
          trackName,
          kind,
          mid: tvr.mid,
          width: plan.h.width,
          height: plan.h.height,
          fps: plan.h.fps,
          simulcast: simulcast(plan),
        },
        offer.sdp!,
      );
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      this.videos.push({ kind, trackName, stream });
      this.published.push({ kind, trackName });
      // Browser-only end path: the user can stop via the browser's own UI —
      // unpublish so other clients drop the tile. The store's local indicator
      // clears on the user's next explicit Stop (idempotent).
      track.onended = () => void this.stopVideo(kind).catch(() => {});
      return { trackName };
    } catch (e) {
      stop();
      if (e instanceof Error && /share_limit/.test(e.message)) this.emitState('share_limit');
      throw e;
    }
  }

  private async stopVideo(kind: 'screen' | 'webcam'): Promise<void> {
    const i = this.videos.findIndex((v) => v.kind === kind);
    if (i < 0) return;
    const [v] = this.videos.splice(i, 1);
    for (const t of v.stream.getTracks()) t.stop();
    this.published = this.published.filter((p) => p.trackName !== v.trackName);
    if (this.channelId) await this.signaling().unpublish(this.channelId, v.trackName);
  }

  // ---- watching streams (dedicated PC per watch, S5.4 parity) ---------------------

  async streamWatch(ownerId: string, trackName: string, layer: 'l' | 'h'): Promise<void> {
    const sig = this.signaling();
    const channelId = this.channelId;
    if (this.voice !== 'connected' || !channelId) throw new Error('not in voice');
    await this.streamUnwatch(ownerId, trackName); // replace (pin swap re-subscribes)

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry: Watch = { ownerId, trackName, layer, pc, stream: null };
    const gotTrack = new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no video track within 10s')), 10_000);
      pc.ontrack = (ev) => {
        clearTimeout(timer);
        resolve(ev.streams[0] ?? new MediaStream([ev.track]));
      };
    });
    try {
      const offer = await sig.subscribe(channelId, ownerId, trackName, layer);
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sig.renegotiateWatch(channelId, ownerId, trackName, answer.sdp!);
      this.watches.set(watchKey(ownerId, trackName), entry);
      entry.stream = await gotTrack;
    } catch (e) {
      pc.close();
      this.watches.delete(watchKey(ownerId, trackName));
      throw e;
    }
  }

  async streamUnwatch(ownerId: string, trackName: string): Promise<void> {
    const key = watchKey(ownerId, trackName);
    const entry = this.watches.get(key);
    if (!entry) return;
    this.watches.delete(key);
    entry.pc.close();
    if (this.channelId) await this.signaling().unsubscribe(this.channelId, ownerId, trackName).catch(() => {});
  }

  /** Web-only: the live MediaStream for a watched tile (StreamTile renders it directly). */
  streamMedia(ownerId: string, trackName: string): MediaStream | null {
    return this.watches.get(watchKey(ownerId, trackName))?.stream ?? null;
  }

  // ---- reconnect (S6.1 parity: recovery windows, no SDP) ---------------------------

  private installReconnect(pc: RTCPeerConnection, epoch: number): void {
    pc.oniceconnectionstatechange = () => {
      if (epoch !== this.epoch) return;
      const st = pc.iceConnectionState;
      if (st !== 'disconnected' && st !== 'failed') return;
      if (this.reconnecting || this.voice !== 'connected') return;
      this.reconnecting = true;
      this.voice = 'reconnecting';
      this.emitState();
      void (async () => {
        for (let i = 0; i < RECONNECT_WINDOWS; i++) {
          const deadline = Date.now() + RECONNECT_WINDOW_MS;
          while (Date.now() < deadline) {
            if (epoch !== this.epoch) return;
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
              this.reconnecting = false;
              this.voice = 'connected';
              this.emitState();
              return;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        if (epoch !== this.epoch) return;
        this.reconnecting = false;
        // Stay in `reconnecting`; the UI reacts with a full re-join (same as desktop).
        this.emitState('reconnect_failed');
      })();
    };
  }

  // ---- levels (10 Hz) + stats (1 Hz) ----------------------------------------------

  private startLevels(): void {
    const buf = new Float32Array(2048);
    const rmsOf = (a: AnalyserNode): number => {
      const n = Math.min(a.fftSize, buf.length);
      a.getFloatTimeDomainData(buf.subarray(0, n));
      let sum = 0;
      for (let i = 0; i < n; i++) sum += buf[i] * buf[i];
      return Math.sqrt(sum / n);
    };
    this.levelsTimer = setInterval(() => {
      const levels: { userId: string; rms: number }[] = [];
      if (this.micAnalyser) levels.push({ userId: '', rms: rmsOf(this.micAnalyser) });
      for (const r of this.subs.values()) levels.push({ userId: r.ownerId, rms: rmsOf(r.analyser) });
      emitEngineEvent('engine://levels', levels);
    }, 100);
  }

  private startStats(pc: RTCPeerConnection, epoch: number): void {
    this.statsTimer = setInterval(() => {
      void (async () => {
        if (epoch !== this.epoch) return;
        let bytesSent = 0;
        let bytesReceived = 0;
        let framesEncoded = 0;
        let framesDecoded = 0;
        let pliCount = 0;
        let rttMs: number | null = null;
        const collect = (report: RTCStatsReport) => {
          report.forEach((s: any) => {
            if (s.type === 'outbound-rtp') {
              bytesSent += s.bytesSent ?? 0;
              framesEncoded += s.framesEncoded ?? 0;
              pliCount += s.pliCount ?? 0;
            } else if (s.type === 'inbound-rtp') {
              bytesReceived += s.bytesReceived ?? 0;
              framesDecoded += s.framesDecoded ?? 0;
              pliCount += s.pliCount ?? 0;
            } else if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime > 0) {
              rttMs = s.currentRoundTripTime * 1000;
            }
          });
        };
        collect(await pc.getStats());
        const streams: unknown[] = [];
        for (const w of this.watches.values()) {
          let wBytes = 0;
          (await w.pc.getStats()).forEach((s: any) => {
            if (s.type === 'inbound-rtp') wBytes += s.bytesReceived ?? 0;
          });
          bytesReceived += wBytes;
          streams.push({
            ownerId: w.ownerId,
            trackName: w.trackName,
            layer: w.layer,
            droppedChunks: 0,
            bytesReceived: wBytes,
            mediaBytes: wBytes,
          });
        }
        if (epoch !== this.epoch) return;
        emitEngineEvent('engine://stats', {
          bytesSent,
          bytesReceived,
          framesEncoded,
          framesDecoded,
          pliCount,
          iceState: pc.iceConnectionState,
          rttMs,
          streams,
        });
      })();
    }, 1000);
  }
}

export const webEngine = new WebEngine();

// e2e/debug handle: lets the real-browser tests assert live engine internals
// (ICE state, AudioContext state, active subs/watches) without reaching into UI.
(globalThis as unknown as Record<string, unknown>).__tavernEngine = webEngine;
