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
    // §1 order: engine voice_leave FIRST, then WS voice.leave.
    try {
      await engine.voiceLeave();
    } catch {
      // engine teardown is best-effort; the WS leave must still go out
    }
    if (serverId) this.sendFrame(serverId, { t: 'voice.leave' });
    this.resetVoiceState();
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
  }

  // hello.ok: the full current roster in one flat list.
  setHelloTracks(serverId: string, tracks: TrackInfo[]): void {
    const grouped: Record<string, TrackInfo[]> = {};
    for (const t of tracks) (grouped[t.ownerId] ??= []).push(t);
    this.tracksByServer = { ...this.tracksByServer, [serverId]: grouped };
    if (this.inVoice && serverId === this.serverId) void this.forwardTracks();
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
