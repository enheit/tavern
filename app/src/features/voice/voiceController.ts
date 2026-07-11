import type { ClientMessage, PresetId, ServerMessage, VoiceMember } from "@tavern/shared";
import { apiClient } from "@/lib/apiClient";
import { installTestHooks } from "@/lib/testHooks";
import type { VoiceStats } from "@/lib/testHooks";
import { connectRoom } from "@/lib/wsClient";
import { AudioGraph } from "@/media/audioGraph";
import { getMic as browserGetMic, retoggleMic as browserRetoggleMic } from "@/media/capture";
import { watchSpeaking as browserWatchSpeaking } from "@/media/levelMeter";
import { browserAudioPort, browserRtcPort } from "@/media/ports";
import { PublishSession } from "@/media/rtc/publishSession";
import type { PublishState } from "@/media/rtc/publishSession";
import { PullSession } from "@/media/rtc/pullSession";
import type { PullState } from "@/media/rtc/pullSession";
import { createSfuSignal } from "@/media/sfuSignal";
import { createSoundFetcher, SoundboardPlayer } from "@/media/soundboardPlayer";
import { micTrackName } from "@/media/trackName";
import { useMediaStore } from "@/stores/media";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

// Thrown by `join` when the client is already in voice on a DIFFERENT server (single-voice rule is
// CLIENT-enforced — §1.4). The confirm flow catches it, leaves there, then joins here.
export class VoiceElsewhereError extends Error {
  readonly serverId: string;
  constructor(serverId: string) {
    super("voice_elsewhere");
    this.name = "VoiceElsewhereError";
    this.serverId = serverId;
  }
}

interface MicOpts {
  deviceId?: string;
  noiseSuppression: boolean;
}

// Structural subsets of the S7.2 engine — the real PublishSession / PullSession / AudioGraph satisfy
// these, so tests inject fakes without casts (§9.1).
interface PublishLike {
  connect(): Promise<void>;
  publishMic(track: MediaStreamTrack): Promise<{ trackName: string }>;
  // §7.1: mic + screen + cam share ONE publishPC. S8.1's screen share publishes through this same
  // session (exposed via `screenPublisher()`); the session owns track naming + App-D encodings.
  publishStream(
    video: MediaStreamTrack,
    audio: MediaStreamTrack | null,
    preset: PresetId,
  ): Promise<{ videoTrackName: string; audioTrackName?: string }>;
  // FR-29: the webcam publishes on the SAME publishPC (§7.1 one-publisher rule); useWebcam publishes
  // through this session (exposed via `webcamPublisher()`), which owns the `cam:{userId}` name + the
  // App-D webcam encodings. `camSender()` backs the pinned mid-publish device switch (replaceTrack).
  publishCam(track: MediaStreamTrack): Promise<{ trackName: string }>;
  unpublish(trackNames: string[]): Promise<void>;
  micSender(): RTCRtpSender | null;
  camSender(): RTCRtpSender | null;
  setTrackEnabled(trackName: string, enabled: boolean): void;
  // FR-27 on-the-fly preset switch (S8.4): applyConstraints + sender.setParameters on the h-encoding,
  // never a renegotiation. Owned by PublishSession (it holds the App-D encodings). useScreenShare drives
  // it on the shared publishPC exposed via screenPublisher().
  setPreset(trackName: string, preset: PresetId): Promise<void>;
  close(): Promise<void>;
  // Optional so unit-test fakes need not implement it; the real PublishSession exposes it. Surfaced
  // via the §10 e2e publish-state hook only.
  readonly state?: PublishState;
}
interface PullLike {
  connect(): Promise<void>;
  onTrack(
    cb: (trackName: string, track: MediaStreamTrack, stream: MediaStream) => void,
  ): () => void;
  addRemoteTracks(tracks: Array<{ trackName: string; preferredRid?: "h" | "l" }>): Promise<void>;
  removeRemoteTracks(trackNames: string[]): Promise<void>;
  close(): Promise<void>;
  // Optional — real PullSession only. Feed the §10 e2e pull-state and voice-stats hooks.
  readonly state?: PullState;
  inboundAudioStats?(): Promise<VoiceStats>;
}
// The subset of the S7.2 AudioGraph that watched-stream tiles route their audio + volume through
// (FR-31). Streams share the ONE app AudioContext (§7.3) — a watcher is always in voice (pulling a
// stream needs an SFU session, S7.1), so the graph is initialized whenever `streamAudioSink()` is
// non-null. Exposed so `useWatch` / `StreamTile` never construct a second AudioContext.
export interface StreamAudioSink {
  attachStreamAudio(streamKey: string, stream: MediaStream): void;
  detachStreamAudio(streamKey: string): void;
  setStreamGain(streamKey: string, gain: number): void;
}

interface GraphLike extends StreamAudioSink {
  init(sinkId?: string): Promise<void>;
  resume(): Promise<void>;
  attachLocalMic(track: MediaStreamTrack): void;
  attachRemoteMic(userId: string, stream: MediaStream): void;
  detachRemoteMic(userId: string): void;
  setUserGain(userId: string, gain: number): void;
  setDeafened(deafened: boolean): void;
  // FR-38: soundboard output gain (0..2), independent of user/stream gains and deafen routing.
  setSoundboardGain(gain: number): void;
  setSink(deviceId: string): Promise<void>;
  getUserAnalyser(userId: string): AnalyserNode | null;
  getLocalAnalyser(): AnalyserNode | null;
  close(): Promise<void>;
}
// FR-36 soundboard player (the real SoundboardPlayer satisfies it) — built per voice server with a
// Cache-API fetcher bound to that serverId. Optional in VoiceDeps so unit-test harnesses omit it.
interface SoundboardLike {
  play(sound: { id: string; trimStartMs: number; trimEndMs: number }): Promise<void>;
  stopAll(): void;
}
interface WsLike {
  send(msg: ClientMessage): void;
  on<T extends ServerMessage["t"]>(
    t: T,
    cb: (m: Extract<ServerMessage, { t: T }>) => void,
  ): () => void;
}

export interface VoiceDeps {
  graph: GraphLike;
  createPublish(serverId: string, userId: string): PublishLike;
  createPull(serverId: string): PullLike;
  wsFor(serverId: string): WsLike;
  getMic(opts: MicOpts): Promise<MediaStreamTrack>;
  retoggleMic(
    current: MediaStreamTrack,
    sender: RTCRtpSender,
    opts: MicOpts,
  ): Promise<MediaStreamTrack>;
  watchSpeaking(analyser: AnalyserNode, cb: (speaking: boolean) => void): () => void;
  // FR-36: builds the soundboard player for one server (Cache-API fetcher bound to serverId + the app
  // graph). Optional — omitted by unit-test harnesses, so playSoundboard is a no-op there.
  createSoundboardPlayer?(serverId: string): SoundboardLike;
}

const MIC_PREFIX = "mic:";

// Non-React orchestrator that owns the voice engine and writes to stores/media.ts. One instance for
// the whole app (single-voice at a time). The JOIN order is load-bearing (§7.1): the DO authorizes
// rtc ops only for in-voice users, so voice.join + its ack precede every rtc call.
export class VoiceController {
  private readonly deps: VoiceDeps;
  private ws: WsLike | null = null;
  private serverId: string | null = null;
  private publish: PublishLike | null = null;
  private pull: PullLike | null = null;
  private localMic: MediaStreamTrack | null = null;
  private micTrackName: string | null = null;
  private userMuted = false;
  private deafened = false;
  // True once graph.init() has run (voice joined) and false after teardown — gates streamAudioSink().
  private graphReady = false;
  private readonly pulledMics = new Set<string>();
  private readonly speakingSubs = new Map<string, () => void>();
  // FR-36 soundboard player for the CURRENT voice server (single-voice-at-a-time); rebuilt lazily when
  // the voice server changes, torn down on leave.
  private soundboard: { serverId: string; player: SoundboardLike } | null = null;
  private unsubVoiceState: (() => void) | null = null;
  private unsubReconnect: (() => void) | null = null;
  private unsubTrack: (() => void) | null = null;

  constructor(deps: VoiceDeps) {
    this.deps = deps;
  }

  private selfId(): string {
    const id = useSessionStore.getState().profile?.userId;
    if (id === undefined) throw new Error("no session profile");
    return id;
  }

  async join(serverId: string): Promise<void> {
    const media = useMediaStore.getState();
    const current = media.inVoiceServerId;
    if (current !== null && current !== serverId) throw new VoiceElsewhereError(current);
    if (current === serverId && media.voiceStatus === "joined") return;
    await this.doJoin(serverId);
  }

  private async doJoin(serverId: string): Promise<void> {
    const selfId = this.selfId();
    const ws = this.deps.wsFor(serverId);
    this.ws = ws;
    this.serverId = serverId;
    const media = useMediaStore.getState();
    media.setVoiceStatus("joining");
    media.setInVoiceServerId(serverId);
    try {
      // ① voice.join, then await the voice.state ack that lists self.
      const ack = this.waitForSelfInVoice(ws, selfId);
      ws.send({ t: "voice.join" });
      await ack;

      // ② graph init + resume (same user gesture). Apply the persisted soundboard gain (FR-38) now so
      // the freshly-created sbGain node starts at the user's saved level.
      const prefs = useMediaStore.getState().deviceSelection;
      await this.deps.graph.init(prefs.sinkId);
      await this.deps.graph.resume();
      this.graphReady = true;
      this.deps.graph.setSoundboardGain(useSettingsStore.getState().volumes.soundboard);

      // ③ acquire mic.
      const mic = await this.deps.getMic(this.micOpts());
      this.localMic = mic;

      // ④ publish connect + publishMic; local analyser feeds the self speaking ring.
      const publish = this.deps.createPublish(serverId, selfId);
      this.publish = publish;
      await publish.connect();
      const { trackName } = await publish.publishMic(mic);
      this.micTrackName = trackName;
      this.deps.graph.attachLocalMic(mic);
      this.startSpeaking(selfId, this.deps.graph.getLocalAnalyser());

      // ⑤ pull connect + pull every existing remote mic in the room store.
      const pull = this.deps.createPull(serverId);
      this.pull = pull;
      this.unsubTrack = pull.onTrack((tn, _t, stream) => this.onPulledTrack(tn, stream));
      await pull.connect();
      const remoteIds = roomStore(serverId)
        .getState()
        .voice.members.map((m) => m.userId)
        .filter((id) => id !== selfId);
      for (const id of remoteIds) this.pulledMics.add(id);
      if (remoteIds.length > 0)
        await pull.addRemoteTracks(remoteIds.map((id) => ({ trackName: micTrackName(id) })));

      this.unsubVoiceState = ws.on("voice.state", (m) => this.onVoiceState(m.voice.members));
      this.unsubReconnect = ws.on("hello.ok", () => void this.onReconnect());
      useMediaStore.getState().setVoiceStatus("joined");
    } catch (err) {
      await this.teardown();
      // voice.join may already have registered us in the roster (any later step can be the failure),
      // so a failed join must not leave a ghost member — best-effort server-side leave.
      try {
        ws.send({ t: "voice.leave" });
      } catch {
        // Socket not open — the join frame never reached the server, nothing to undo.
      }
      this.resetState();
      const m = useMediaStore.getState();
      m.setVoiceStatus("error");
      m.setInVoiceServerId(null);
      throw err;
    }
  }

  async leave(): Promise<void> {
    if (this.serverId === null) return;
    const ws = this.ws;
    useMediaStore.getState().setVoiceStatus("leaving");
    // Reverse teardown FIRST (close sessions/graph while still authorized in voice), THEN voice.leave.
    await this.teardown();
    ws?.send({ t: "voice.leave" });
    this.resetState();
    const media = useMediaStore.getState();
    media.setVoiceStatus("idle");
    media.setInVoiceServerId(null);
    media.setMuted(false);
    media.setDeafened(false);
    media.clearSpeaking();
  }

  // §6.2 snapshot semantics: a reconnect resnapshots (self dropped from voice server-side) — full
  // teardown + rejoin, restoring the self mute/deafen flags.
  private async onReconnect(): Promise<void> {
    const serverId = this.serverId;
    if (serverId === null || useMediaStore.getState().voiceStatus !== "joined") return;
    const wasMuted = this.userMuted;
    const wasDeafened = this.deafened;
    await this.teardown();
    await this.doJoin(serverId);
    if (wasDeafened) this.setDeafened(true);
    if (wasMuted) this.setMuted(true);
  }

  setMuted(muted: boolean): void {
    this.userMuted = muted;
    this.applyMuteState();
    this.sendVoiceState();
    useMediaStore.getState().setMuted(this.effectiveMuted());
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    this.deps.graph.setDeafened(deafened);
    // FR-36 pinned: deafen stops in-flight soundboard audio (and suppresses new plays until undeafened
    // — the play guard checks `this.deafened`). stopAll cuts the live sources via graph.stopSoundboard.
    if (deafened) this.soundboard?.player.stopAll();
    this.applyMuteState();
    this.sendVoiceState();
    const media = useMediaStore.getState();
    media.setDeafened(deafened);
    media.setMuted(this.effectiveMuted());
  }

  // FR-38 soundboard volume: applies the gain (0..2) to the app graph's soundboard node. The panel
  // persists the value to settings.volumes.v1; this only routes it to the live audio graph.
  setSoundboardGain(gain: number): void {
    this.deps.graph.setSoundboardGain(gain);
  }

  // FR-36: play a sound locally ONLY when in voice on THIS server and not deafened (non-voice members
  // and deafened members never hear it — they only bump the badge, done by the sounds hook). The player
  // is built lazily per voice server; a test harness without the factory makes this a no-op.
  async playSoundboard(
    serverId: string,
    sound: { id: string; trimStartMs: number; trimEndMs: number },
  ): Promise<void> {
    const media = useMediaStore.getState();
    if (media.inVoiceServerId !== serverId || media.voiceStatus !== "joined") return;
    if (this.deafened) return;
    const player = this.ensureSoundboard(serverId);
    if (player) await player.play(sound);
  }

  private ensureSoundboard(serverId: string): SoundboardLike | null {
    if (this.soundboard?.serverId === serverId) return this.soundboard.player;
    const player = this.deps.createSoundboardPlayer?.(serverId);
    this.soundboard = player ? { serverId, player } : null;
    return player ?? null;
  }

  // FR-20 per-user local volume (stored gain float 0..2) + per-user mute (set membership).
  setUserVolume(userId: string, gain: number): void {
    const s = useSettingsStore.getState();
    s.setVolumes({ ...s.volumes, users: { ...s.volumes.users, [userId]: gain } });
    this.applyUserVolume(userId);
  }

  setUserMuted(userId: string, muted: boolean): void {
    const s = useSettingsStore.getState();
    const set = new Set(s.volumes.mutedUsers);
    if (muted) set.add(userId);
    else set.delete(userId);
    s.setVolumes({ ...s.volumes, mutedUsers: [...set] });
    this.applyUserVolume(userId);
  }

  // FR-22/21 input or noise change mid-call — stop → reacquire → replaceTrack (never renegotiates).
  async retoggleMic(): Promise<void> {
    const sender = this.publish?.micSender();
    if (!this.localMic || !sender) return;
    const next = await this.deps.retoggleMic(this.localMic, sender, this.micOpts());
    this.localMic = next;
    this.deps.graph.attachLocalMic(next);
    this.startSpeaking(this.selfId(), this.deps.graph.getLocalAnalyser());
  }

  // S8.1 screen share publishes on the SAME publishPC as the mic (§7.1 one-publisher rule). Returns
  // the shared session (null before voice is joined) so useScreenShare never creates a second one.
  screenPublisher(): PublishLike | null {
    return this.publish;
  }

  // S8.3 webcam publishes on that same shared publishPC (§7.1 one-publisher rule) — returns the live
  // session (null before voice is joined) so useWebcam never creates a second PublishSession.
  webcamPublisher(): PublishLike | null {
    return this.publish;
  }

  // FR-25 recording seam (S9.3): the recorder mixes the shared audio graph + the live mic, both owned
  // here. Exposed like screenPublisher() so the RecordButton drives the recorder without a second
  // graph/mic. Null until fully joined (mic acquired). `instanceof` narrows GraphLike → AudioGraph
  // without a cast (§9.1); the fake graph in unit tests is not an AudioGraph, so it never reaches here.
  recorderInputs(): { graph: AudioGraph; localMic: MediaStreamTrack } | null {
    const graph = this.deps.graph;
    if (!(graph instanceof AudioGraph) || this.localMic === null) return null;
    return { graph, localMic: this.localMic };
  }

  // FR-21 output change — reroutes remote voice, streams, and soundboard (§7.3).
  async setSink(sinkId: string): Promise<void> {
    if (this.publish === null) return;
    await this.deps.graph.setSink(sinkId);
  }

  private micOpts(): MicOpts {
    const prefs = useMediaStore.getState().deviceSelection;
    return {
      ...(prefs.micId ? { deviceId: prefs.micId } : {}),
      noiseSuppression: prefs.noiseSuppression,
    };
  }

  private effectiveMuted(): boolean {
    return this.deafened || this.userMuted;
  }

  private applyMuteState(): void {
    if (this.publish && this.micTrackName !== null)
      this.publish.setTrackEnabled(this.micTrackName, !this.effectiveMuted());
  }

  private sendVoiceState(): void {
    this.ws?.send({ t: "voice.state", muted: this.effectiveMuted(), deafened: this.deafened });
  }

  private applyUserVolume(userId: string): void {
    const vol = useSettingsStore.getState().volumes;
    const gain = vol.mutedUsers.includes(userId) ? 0 : (vol.users[userId] ?? 1);
    this.deps.graph.setUserGain(userId, gain);
  }

  private onPulledTrack(trackName: string, stream: MediaStream): void {
    if (!trackName.startsWith(MIC_PREFIX)) return;
    const userId = trackName.slice(MIC_PREFIX.length);
    this.deps.graph.attachRemoteMic(userId, stream);
    this.applyUserVolume(userId);
    this.startSpeaking(userId, this.deps.graph.getUserAnalyser(userId));
  }

  private onVoiceState(members: VoiceMember[]): void {
    const selfId = this.selfId();
    const ids = new Set(members.map((m) => m.userId));
    for (const id of ids) {
      if (id === selfId || this.pulledMics.has(id)) continue;
      this.pulledMics.add(id);
      this.pullMicWithRetry(id, 0);
    }
    for (const id of Array.from(this.pulledMics)) {
      if (ids.has(id)) continue;
      this.pulledMics.delete(id);
      void this.pull?.removeRemoteTracks([micTrackName(id)]);
      this.deps.graph.detachRemoteMic(id);
      this.stopSpeaking(id);
      useMediaStore.getState().setSpeaking(id, false);
    }
  }

  // voice.state announcing a joiner races that joiner's REST publish (§7.1): the mic track may not
  // be registered yet, so the first pull can 403 (pull_denied). Retry briefly (10 × 500 ms covers
  // any realistic publish handshake); on final failure unmark the id so a later voice.state
  // retriggers the pull instead of leaving the member permanently silent (S12.3 soak finding).
  private pullMicWithRetry(id: string, attempt: number): void {
    const pull = this.pull;
    if (pull === null) return;
    pull.addRemoteTracks([{ trackName: micTrackName(id) }]).catch(() => {
      if (!this.pulledMics.has(id)) return; // member already left — the pull is moot
      if (attempt >= 9) {
        this.pulledMics.delete(id);
        return;
      }
      setTimeout(() => {
        if (this.pulledMics.has(id)) this.pullMicWithRetry(id, attempt + 1);
      }, 500);
    });
  }

  private startSpeaking(userId: string, analyser: AnalyserNode | null): void {
    if (!analyser) return;
    this.stopSpeaking(userId);
    this.speakingSubs.set(
      userId,
      this.deps.watchSpeaking(analyser, (sp) => useMediaStore.getState().setSpeaking(userId, sp)),
    );
  }

  private stopSpeaking(userId: string): void {
    this.speakingSubs.get(userId)?.();
    this.speakingSubs.delete(userId);
  }

  private waitForSelfInVoice(ws: WsLike, selfId: string): Promise<void> {
    return new Promise((resolve) => {
      const unsub = ws.on("voice.state", (m) => {
        if (m.voice.members.some((mem) => mem.userId === selfId)) {
          unsub();
          resolve();
        }
      });
    });
  }

  private async teardown(): Promise<void> {
    // FR-36: cut any in-flight soundboard audio on voice leave, then drop the per-server player.
    this.soundboard?.player.stopAll();
    this.soundboard = null;
    this.unsubVoiceState?.();
    this.unsubReconnect?.();
    this.unsubTrack?.();
    this.unsubVoiceState = null;
    this.unsubReconnect = null;
    this.unsubTrack = null;
    for (const stop of this.speakingSubs.values()) stop();
    this.speakingSubs.clear();
    for (const id of this.pulledMics) this.deps.graph.detachRemoteMic(id);
    this.pulledMics.clear();
    await this.pull?.close();
    this.pull = null;
    await this.publish?.close();
    this.publish = null;
    await this.deps.graph.close();
    this.graphReady = false;
    this.localMic?.stop();
    this.localMic = null;
    this.micTrackName = null;
  }

  // S8.2: watched-stream tiles route their audio (attach) + volume (setStreamGain) through the SAME
  // AudioGraph as voice (one AudioContext, §7.3). Returns the graph as a narrow sink while voice is
  // joined, else null (no context yet). A watcher is always in voice — pulling a stream needs an SFU
  // session, which S7.1 authorizes only for in-voice users.
  streamAudioSink(): StreamAudioSink | null {
    return this.graphReady ? this.deps.graph : null;
  }

  // Read-only live views for the §10 e2e test hooks (installTestHooks). Product-neutral — they only
  // surface existing session state and never mutate anything.
  publishStateForTest(): PublishState {
    return this.publish?.state ?? "idle";
  }

  pullStatesForTest(): Record<string, PullState> {
    const state = this.pull?.state;
    return state === undefined ? {} : { voice: state };
  }

  voiceStatsForTest(): Promise<VoiceStats> {
    return (
      this.pull?.inboundAudioStats?.() ?? Promise.resolve({ bytesReceived: 0, audioLevel: null })
    );
  }

  private resetState(): void {
    this.ws = null;
    this.serverId = null;
    this.userMuted = false;
    this.deafened = false;
  }
}

let singleton: VoiceController | null = null;

// Lazily builds the app-wide controller with the real browser engine ports (§7.1/§7.2 seams). Tests
// construct VoiceController directly with fakes and never touch this.
export function getVoiceController(): VoiceController {
  if (singleton) return singleton;
  const signal = createSfuSignal(apiClient);
  // ONE app AudioGraph — shared by voice (deps.graph) and the soundboard players (same output sink,
  // deafen routing, and sbGain node). §7.3 one AudioContext for the whole app.
  const graph = new AudioGraph(browserAudioPort);
  const controller = new VoiceController({
    graph,
    createPublish: (serverId, userId) =>
      new PublishSession({ rtc: browserRtcPort, signal, serverId, userId }),
    createPull: (serverId) => new PullSession({ rtc: browserRtcPort, signal, serverId }),
    wsFor: (serverId) => connectRoom(serverId),
    getMic: browserGetMic,
    retoggleMic: browserRetoggleMic,
    watchSpeaking: browserWatchSpeaking,
    createSoundboardPlayer: (serverId) =>
      new SoundboardPlayer({ graph, fetchSound: createSoundFetcher(serverId) }),
  });
  singleton = controller;
  // §10: installs window.__tavernTestAudio / __tavernTestRtc when platform.isE2E — the SOLE wiring
  // site for the e2e hooks (installTestHooks owns the global assignment).
  installTestHooks({
    publishState: () => controller.publishStateForTest(),
    pullStates: () => controller.pullStatesForTest(),
    voiceStats: () => controller.voiceStatsForTest(),
  });
  return controller;
}
