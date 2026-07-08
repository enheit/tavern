import type { ClientFrame } from '../protocol/ClientFrame';
import type { Presence } from '../protocol/Presence';
import type { TrackInfo } from '../protocol/TrackInfo';
import { engine } from '../engine';
import { onEngineEvent } from '../events';
import { getPref, setPref } from '../prefs';
import { auth } from './auth.svelte';
import { servers } from './servers.svelte';

// §1 S4.2 fixed sequencing: WS voice.join → wait for our own `presence {state:"voice"}`
// broadcast (5 s timeout → error toast) → THEN engine voice_join. Leave is the reverse:
// engine voice_leave first, then WS voice.leave. Cross-server join = full leave first.
export const JOIN_TIMEOUT_MS = 5_000;
// §1 speaking ring: RMS > 0.02 sustained for ≥100 ms.
export const SPEAKING_RMS = 0.02;
export const SPEAKING_HOLD_MS = 100;

export type VoiceStatus = 'idle' | 'joining' | 'in';

// §0: ≤3 simultaneous screen shares per channel (Start disabled at the cap, server 409s past it).
export const SHARE_CAP = 3;
// §0 resolution choices → the screen_share_start {width,height} payload; native = 0×0 (§1).
// Fixed rows use the canonical 16:9 dims; the engine sizes by height + real source aspect.
export const SHARE_RES: Record<string, { width: number; height: number }> = {
  native: { width: 0, height: 0 },
  '360': { width: 640, height: 360 },
  '480': { width: 854, height: 480 },
  '720': { width: 1280, height: 720 },
  '1080': { width: 1920, height: 1080 },
  '1440': { width: 2560, height: 1440 },
};
export const SHARE_FPS = [15, 30, 60, 120];

interface Level {
  userId: string;
  rms: number;
}

export class VoiceStore {
  status = $state<VoiceStatus>('idle');
  serverId = $state<string | null>(null);
  channelId = $state<string | null>(null);
  muted = $state(false);
  deafened = $state(false);
  error = $state<string | null>(null);
  micTrackName = $state<string | null>(null);
  // Our live screen share, if any ("You are sharing").
  sharing = $state<{ trackName: string } | null>(null);
  // Streams we joined (§0: manual join per stream): tileKey → watched layer.
  watched = $state<Record<string, 'l' | 'h'>>({});
  // Exactly one pinnable tile → layer "h"; all others watch "l" (§1). Holds a tileKey.
  pinned = $state<string | null>(null);
  speaking = $state<Record<string, boolean>>({});
  // Full track roster per server (ownerId → their tracks), fed by hello.ok + `tracks`
  // frames; flattened and forwarded to the engine while in voice (§1).
  tracksByServer = $state<Record<string, Record<string, TrackInfo[]>>>({});

  // WS seam: ws.svelte.ts binds this to the pool; tests override with a spy.
  sendFrame: (serverId: string, frame: ClientFrame) => void = () => {};

  private waiter: { serverId: string; channelId: string; resolve: (ok: boolean) => void } | null = null;
  private waiterTimer: ReturnType<typeof setTimeout> | null = null;
  private aboveSince = new Map<string, number>();

  constructor() {
    onEngineEvent('engine://levels', (payload) => this.onLevels(payload as Level[]));
  }

  get inVoice(): boolean {
    return this.status === 'in';
  }

  // Users (excluding self) currently in our voice channel, for the panel rows.
  get participants(): string[] {
    if (!this.serverId || !this.channelId) return [];
    const pres = servers.presenceByServer[this.serverId] ?? {};
    return Object.values(pres)
      .filter((p) => p.state === 'voice' && p.channelId === this.channelId && p.userId !== auth.userId)
      .map((p) => p.userId);
  }

  async join(serverId: string, channelId: string): Promise<void> {
    if (this.status === 'joining') return; // a join is already in flight
    if (this.inVoice) {
      if (this.serverId === serverId && this.channelId === channelId) return;
      await this.leave(); // §1 cross-server/channel: full leave first
    }
    this.error = null;
    this.status = 'joining';
    this.serverId = serverId;
    this.channelId = channelId;

    this.sendFrame(serverId, { t: 'voice.join', channelId });
    const ok = await this.waitForOwnVoicePresence(serverId, channelId);
    if (!ok) {
      // Best-effort converge in case the join landed but the broadcast didn't reach us.
      this.sendFrame(serverId, { t: 'voice.leave' });
      this.resetVoiceState();
      this.error = 'Could not join voice (timed out)';
      return;
    }

    try {
      const joined = await engine.voiceJoin(channelId);
      this.micTrackName = joined?.trackName ?? null;
      this.status = 'in';
      // Re-assert toggles + persisted per-user gains onto the fresh engine session.
      await engine.setMicMuted(this.muted);
      await engine.setDeafened(this.deafened);
      for (const userId of this.participants) this.applyStoredGain(userId);
      await this.forwardTracks();
    } catch (e) {
      // Engine failed after the WS said voice → roll the WS side back too.
      this.sendFrame(serverId, { t: 'voice.leave' });
      this.resetVoiceState();
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async leave(): Promise<void> {
    if (this.status !== 'in') return;
    const serverId = this.serverId;
    // §1 order: engine voice_leave FIRST (which also tears down any live share), then WS.
    try {
      await engine.voiceLeave();
    } catch {
      // engine teardown is best-effort; the WS leave must still go out
    }
    if (serverId) this.sendFrame(serverId, { t: 'voice.leave' });
    this.resetVoiceState();
  }

  // ---- screen share (S5.3) ---------------------------------------------------

  // Screen tracks visible in OUR voice channel: tracks carry no channelId, so join
  // owners' tracks with their presence (a publisher must be in voice in the channel).
  get screenTrackCount(): number {
    if (!this.serverId || !this.channelId) return 0;
    const pres = servers.presenceByServer[this.serverId] ?? {};
    const byOwner = this.tracksByServer[this.serverId] ?? {};
    let n = 0;
    for (const [ownerId, tracks] of Object.entries(byOwner)) {
      const p = pres[ownerId];
      if (!p || p.state !== 'voice' || p.channelId !== this.channelId) continue;
      n += tracks.filter((t) => t.kind === 'screen').length;
    }
    return n;
  }

  get shareDisabled(): boolean {
    return this.screenTrackCount >= SHARE_CAP;
  }

  // ---- watching streams (S5.4) -------------------------------------------------

  static tileKey(t: { ownerId: string; trackName: string }): string {
    return `${t.ownerId}/${t.trackName}`;
  }

  // Video tiles: screen/webcam tracks of OTHER users in our voice channel (owner
  // presence joined, same rule as screenTrackCount).
  get videoTiles(): TrackInfo[] {
    if (!this.serverId || !this.channelId) return [];
    const pres = servers.presenceByServer[this.serverId] ?? {};
    const byOwner = this.tracksByServer[this.serverId] ?? {};
    const tiles: TrackInfo[] = [];
    for (const [ownerId, tracks] of Object.entries(byOwner)) {
      if (ownerId === auth.userId) continue;
      const p = pres[ownerId];
      if (!p || p.state !== 'voice' || p.channelId !== this.channelId) continue;
      tiles.push(...tracks.filter((t) => t.kind === 'screen' || t.kind === 'webcam'));
    }
    return tiles;
  }

  layerFor(key: string): 'l' | 'h' {
    return this.pinned === key ? 'h' : 'l';
  }

  joinStream(t: TrackInfo): void {
    const key = VoiceStore.tileKey(t);
    this.watched = { ...this.watched, [key]: this.layerFor(key) };
  }

  leaveStream(t: TrackInfo): void {
    const key = VoiceStore.tileKey(t);
    const next = { ...this.watched };
    delete next[key];
    this.watched = next;
    if (this.pinned === key) this.pinned = null;
  }

  // Pin swap: layers flip and each affected tile re-subscribes (unwatch+watch, §1).
  // Non-simulcast tiles cannot be pinned (single encoding — the UI disables the control).
  togglePin(t: TrackInfo): void {
    if (!t.simulcast) return;
    const key = VoiceStore.tileKey(t);
    this.pinned = this.pinned === key ? null : key;
    // Refresh watched layers so tile effects re-run with the new layer.
    const next: Record<string, 'l' | 'h'> = {};
    for (const k of Object.keys(this.watched)) next[k] = this.layerFor(k);
    this.watched = next;
  }

  // Tile-effect plumbing: the tile owns the Channel + decoder; the store owns the invokes.
  async startStream(t: TrackInfo, layer: 'l' | 'h', onChunk: (buf: ArrayBuffer) => void): Promise<void> {
    try {
      await engine.streamWatch(t.ownerId, t.trackName, layer, onChunk);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async stopStream(t: TrackInfo): Promise<void> {
    try {
      await engine.streamUnwatch(t.ownerId, t.trackName);
    } catch {
      // best-effort; the server sweeps on ws-close/leave
    }
  }

  async shareStart(sourceId: string, width: number, height: number, fps: number): Promise<void> {
    if (!this.inVoice || this.sharing) return;
    try {
      const r = await engine.screenShareStart(sourceId, width, height, fps);
      if (r) this.sharing = { trackName: r.trackName };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async shareStop(): Promise<void> {
    if (!this.sharing) return;
    try {
      await engine.screenShareStop();
    } catch {
      // local indicator clears regardless; the server sweeps stale tracks
    }
    this.sharing = null;
  }

  toggleMute(): void {
    this.muted = !this.muted;
    void engine.setMicMuted(this.muted);
  }

  // Deafen never touches `muted` — the engine suppresses the mic while deafened and
  // restores the prior mic state on undeafen (§1).
  toggleDeafen(): void {
    this.deafened = !this.deafened;
    void engine.setDeafened(this.deafened);
  }

  // Personal volume, 0.0–2.0 (§0: 0–200%), persisted per userId.
  gain(userId: string): number {
    const v = getPref(`gain:${userId}`);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : 1;
  }

  setGain(userId: string, gain: number): void {
    setPref(`gain:${userId}`, String(gain));
    void engine.setUserGain(userId, gain);
  }

  // ---- WS-fed hooks (called from applyServerFrame) --------------------------

  notifyPresence(serverId: string, p: Presence): void {
    const w = this.waiter;
    if (
      w &&
      serverId === w.serverId &&
      p.userId === auth.userId &&
      p.state === 'voice' &&
      p.channelId === w.channelId
    ) {
      this.clearWaiter();
      w.resolve(true);
    }
    // Someone entered our voice channel → re-apply their persisted slider.
    if (this.inVoice && serverId === this.serverId && p.state === 'voice' && p.userId !== auth.userId) {
      this.applyStoredGain(p.userId);
    }
  }

  // `tracks` broadcast: full replace for one owner (§1).
  applyTracks(serverId: string, ownerId: string, tracks: TrackInfo[]): void {
    const cur = { ...(this.tracksByServer[serverId] ?? {}) };
    if (tracks.length) cur[ownerId] = tracks;
    else delete cur[ownerId];
    this.tracksByServer = { ...this.tracksByServer, [serverId]: cur };
    if (this.inVoice && serverId === this.serverId) void this.forwardTracks();
    this.pruneWatched();
  }

  // hello.ok: the full current roster in one flat list.
  setHelloTracks(serverId: string, tracks: TrackInfo[]): void {
    const grouped: Record<string, TrackInfo[]> = {};
    for (const t of tracks) (grouped[t.ownerId] ??= []).push(t);
    this.tracksByServer = { ...this.tracksByServer, [serverId]: grouped };
    if (this.inVoice && serverId === this.serverId) void this.forwardTracks();
    this.pruneWatched();
  }

  // §1: a watched/pinned track vanishing from the roster resets its state (pin → none).
  private pruneWatched(): void {
    const live = new Set(this.videoTiles.map((t) => VoiceStore.tileKey(t)));
    const next: Record<string, 'l' | 'h'> = {};
    for (const [k, v] of Object.entries(this.watched)) if (live.has(k)) next[k] = v;
    if (Object.keys(next).length !== Object.keys(this.watched).length) this.watched = next;
    if (this.pinned && !live.has(this.pinned)) this.pinned = null;
  }

  reset(): void {
    this.clearWaiter();
    this.resetVoiceState();
    this.error = null;
    this.muted = false;
    this.deafened = false;
    this.tracksByServer = {};
  }

  // ---- internals -------------------------------------------------------------

  private waitForOwnVoicePresence(serverId: string, channelId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.waiter = { serverId, channelId, resolve };
      this.waiterTimer = setTimeout(() => {
        this.waiter = null;
        this.waiterTimer = null;
        resolve(false);
      }, JOIN_TIMEOUT_MS);
    });
  }

  private clearWaiter(): void {
    if (this.waiterTimer) clearTimeout(this.waiterTimer);
    this.waiterTimer = null;
    this.waiter = null;
  }

  private resetVoiceState(): void {
    this.status = 'idle';
    this.serverId = null;
    this.channelId = null;
    this.micTrackName = null;
    this.sharing = null;
    this.watched = {};
    this.pinned = null;
    this.speaking = {};
    this.aboveSince.clear();
  }

  private applyStoredGain(userId: string): void {
    const v = getPref(`gain:${userId}`);
    if (v != null && Number.isFinite(Number(v))) void engine.setUserGain(userId, Number(v));
  }

  private forwardTracks(): Promise<void> {
    const all = this.serverId ? Object.values(this.tracksByServer[this.serverId] ?? {}).flat() : [];
    return engine.setRemoteTracks(all);
  }

  private onLevels(levels: Level[]): void {
    const now = Date.now();
    const next: Record<string, boolean> = { ...this.speaking };
    for (const { userId, rms } of levels) {
      if (rms > SPEAKING_RMS) {
        const since = this.aboveSince.get(userId) ?? now;
        this.aboveSince.set(userId, since);
        next[userId] = now - since >= SPEAKING_HOLD_MS;
      } else {
        this.aboveSince.delete(userId);
        next[userId] = false;
      }
    }
    this.speaking = next;
  }
}

export const voice = new VoiceStore();
