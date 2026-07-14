import type {
  ClientMessage,
  PresetId,
  ScreenRid,
  ServerMessage,
  VoiceMember,
} from "@tavern/shared";
import { apiClient } from "@/lib/apiClient";
import { clearMediaOwner, markMediaOwner } from "@/lib/mediaOwnership";
import { installTestHooks } from "@/lib/testHooks";
import type { OutboundVideoLayer, VoiceStats } from "@/lib/testHooks";
import { connectRoom } from "@/lib/wsClient";
import { AudioGraph } from "@/media/audioGraph";
import { getMic as browserGetMic, retoggleMic as browserRetoggleMic } from "@/media/capture";
import { watchSpeaking as browserWatchSpeaking } from "@/media/levelMeter";
import type { SpeakingOpts } from "@/media/levelMeter";
import { browserAudioPort, browserRtcPort } from "@/media/ports";
import { PublishSession } from "@/media/rtc/publishSession";
import type { OutboundVideoLayerStats, PublishState } from "@/media/rtc/publishSession";
import type { ScreenCodec } from "@/media/rtc/codecs";
import { PullSession } from "@/media/rtc/pullSession";
import type { PullState } from "@/media/rtc/pullSession";
import { createSfuSignal } from "@/media/sfuSignal";
import { createSoundFetcher, SoundboardPlayer } from "@/media/soundboardPlayer";
import { micTrackName } from "@/media/trackName";
import { clearVoiceLevel, clearVoiceLevels, setVoiceLevel } from "@/media/voiceLevelBus";
import { playUiSound } from "@/lib/uiSounds";
import { useMediaStore } from "@/stores/media";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { type NoiseSuppressionMode, useSettingsStore } from "@/stores/settings";

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
  noiseSuppression: NoiseSuppressionMode;
  // The shared app AudioContext (§7.3) that the WASM noise-suppression worklet modes run in.
  // Absent when the graph is a unit-test fake or not initialized — worklet modes then degrade to
  // raw capture inside the capture layer.
  audioContext?: AudioContext;
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
    codec: ScreenCodec,
  ): Promise<{ videoTrackName: string; audioTrackName?: string }>;
  // FR-29: the webcam publishes on the SAME publishPC (§7.1 one-publisher rule); useWebcam publishes
  // through this session (exposed via `webcamPublisher()`), which owns the `cam:{userId}` name + the
  // App-D webcam encodings. `camSender()` backs the pinned mid-publish device switch (replaceTrack).
  publishCam(track: MediaStreamTrack): Promise<{ trackName: string }>;
  unpublish(trackNames: string[]): Promise<void>;
  micSender(): RTCRtpSender | null;
  camSender(): RTCRtpSender | null;
  setTrackEnabled(trackName: string, enabled: boolean): void;
  // FR-27 in-ceiling preset switch: sender.setParameters updates all encodings without capture
  // constraint churn or renegotiation. useScreenShare drives it on the shared publishPC.
  setPreset(trackName: string, preset: PresetId): Promise<void>;
  replaceScreenTrack(
    trackName: string,
    nextTrack: MediaStreamTrack,
    preset: PresetId,
  ): Promise<void>;
  close(): Promise<void>;
  // Optional — real PublishSession only. Rebuilds failed or reconnected-but-stale media sessions.
  onConnectionRecoveryNeeded?(cb: () => void): () => void;
  // Optional so unit-test fakes need not implement it; the real PublishSession exposes it. Surfaced
  // via the §10 e2e publish-state hook only.
  readonly state?: PublishState;
  // Optional (test fakes omit it) — per-rid outbound-rtp video summary for the §10 @realtime hook
  // (publisher-side FR-27 fault-domain split; see PublishSession.outboundVideoStats).
  outboundVideoStats?(trackName: string): Promise<OutboundVideoLayerStats[]>;
}
interface PullLike {
  connect(): Promise<void>;
  onTrack(
    cb: (trackName: string, track: MediaStreamTrack, stream: MediaStream) => void,
  ): () => void;
  addRemoteTracks(tracks: Array<{ trackName: string; preferredRid?: ScreenRid }>): Promise<void>;
  removeRemoteTracks(trackNames: string[]): Promise<void>;
  close(): Promise<void>;
  // Optional — real PullSession only. See PublishLike.onConnectionRecoveryNeeded.
  onConnectionRecoveryNeeded?(cb: () => void): () => void;
  // Optional — real PullSession only. Feed the §10 e2e pull-state and voice-stats hooks.
  readonly state?: PullState;
  inboundAudioStats?(): Promise<VoiceStats>;
  inboundAudioBytesByTrack?(): Promise<Record<string, number>>;
}
// The subset of the S7.2 AudioGraph that watched-stream tiles route their audio + volume through
// (FR-31). Streams share the ONE app AudioContext (§7.3) — a watcher is always in voice (pulling a
// stream needs an SFU session, S7.1), so the graph is initialized whenever `streamAudioSink()` is
// non-null. Exposed so `useWatch` / `StreamTile` never construct a second AudioContext.
export interface StreamAudioSink {
  attachStreamAudio(streamKey: string, stream: MediaStream): void;
  detachStreamAudio(streamKey: string): void;
  // Accepts the persisted/user-facing level 0..2; AudioGraph owns the perceptual gain conversion.
  setStreamVolume(streamKey: string, level: number): void;
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
  play(
    sound: { id: string; trimStartMs: number; trimEndMs: number; gain: number },
    mode?: "shared" | "local-preview" | "editor-preview",
  ): Promise<void>;
  playBytes(
    bytes: ArrayBuffer,
    sound: { id: string; trimStartMs: number; trimEndMs: number; gain: number },
    mode: "editor-preview",
    onStarted?: () => void,
  ): Promise<void>;
  stopAll(): void;
  stop(soundId: string): void;
  stopPreview(soundId?: string): void;
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
  watchSpeaking(
    analyser: AnalyserNode,
    cb: (speaking: boolean) => void,
    opts?: SpeakingOpts,
  ): () => void;
  // FR-36: builds the soundboard player for one server (Cache-API fetcher bound to serverId + the app
  // graph). Optional — omitted by unit-test harnesses, so playSoundboard is a no-op there.
  createSoundboardPlayer?(serverId: string): SoundboardLike;
}

const MIC_PREFIX = "mic:";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Observe a startup promise immediately and turn it into data. Join starts independent graph,
// capture, publish, and pull work; keeping every rejection observed lets the controller wait for
// sibling work to settle before teardown, so a late session cannot come alive after an error.
function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

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
  // A `voice.state` frame is valid only after the room has accepted `voice.join`. This keeps the
  // persistent idle controls as local pre-call preferences instead of sending against no session.
  private voiceStateReady = false;
  // True once graph.init() has run (voice joined) and false after teardown — gates streamAudioSink().
  private graphReady = false;
  private readonly pulledMics = new Set<string>();
  // userId → the micSeq (shared VoiceMember.micSeq) the current pull was made against. A voice.state
  // carrying a HIGHER seq means the member re-registered their mic on a new SFU session (rejoin /
  // transport recovery) — the existing pull points at a dead track and must be redone.
  private readonly micSeqs = new Map<string, number>();
  // Single-flight guard for the transport-failure auto-recover (one ICE 'failed' can fire on both
  // the publish and pull PCs at once — one rejoin covers both).
  private recovering = false;
  private readonly speakingSubs = new Map<string, () => void>();
  private readonly voiceMemberIds = new Set<string>();
  private readonly streamTrackNames = new Set<string>();
  private soundEffectsReady = false;
  // FR-36 soundboard player for the CURRENT voice server (single-voice-at-a-time); rebuilt lazily when
  // the voice server changes, torn down on leave.
  private soundboard: { serverId: string; player: SoundboardLike } | null = null;
  private unsubVoiceState: (() => void) | null = null;
  private unsubReconnect: (() => void) | null = null;
  private unsubTrack: (() => void) | null = null;
  private unsubStreamAdded: (() => void) | null = null;
  private unsubStreamRemoved: (() => void) | null = null;
  private unsubSoundPlayed: (() => void) | null = null;
  private unsubSoundStopped: (() => void) | null = null;
  private unsubPublishFailed: (() => void) | null = null;
  private unsubPullFailed: (() => void) | null = null;

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

  private async doJoin(serverId: string, opts: { announceSelf?: boolean } = {}): Promise<void> {
    const selfId = this.selfId();
    const ws = this.deps.wsFor(serverId);
    this.ws = ws;
    this.serverId = serverId;
    this.soundEffectsReady = false;
    this.voiceMemberIds.clear();
    for (const member of roomStore(serverId).getState().voice.members) {
      this.voiceMemberIds.add(member.userId);
    }
    this.streamTrackNames.clear();
    for (const stream of roomStore(serverId).getState().streams) {
      this.streamTrackNames.add(stream.trackName);
    }
    this.unsubVoiceState = ws.on("voice.state", (m) => this.onVoiceState(m.voice.members));
    this.unsubStreamAdded = ws.on("stream.added", (m) => this.onStreamAdded(m.stream.trackName));
    this.unsubStreamRemoved = ws.on("stream.removed", (m) => this.onStreamRemoved(m.trackName));
    const media = useMediaStore.getState();
    media.setVoiceStatus("joining");
    media.setInVoiceServerId(serverId);
    try {
      // ① Register presence. The DO authorizes every RTC call from this ack onward; local audio
      // preparation is safe to overlap with it because it does not touch the SFU.
      const ack = this.waitForSelfInVoice(ws, selfId);
      // Persist only the owning tab/server identity. A replacement document uses it to clear this
      // non-resumable browser media lifetime before rendering its first room snapshot.
      markMediaOwner(serverId);
      ws.send({ t: "voice.join", mediaReadyVersion: 2 });
      const prefs = useMediaStore.getState().deviceSelection;
      const graphReady = (async () => {
        await this.deps.graph.init(prefs.sinkId);
        await this.resumeGraph();
        this.graphReady = true;
        this.applyDeafenState();
        const volumes = useSettingsStore.getState().volumes;
        this.deps.graph.setSoundboardGain(volumes.soundboardMuted ? 0 : volumes.soundboard);
      })();
      const graphResult = outcome(graphReady);

      await ack;
      this.voiceStateReady = true;
      const preparedGraph = await graphResult;
      if (!preparedGraph.ok) throw preparedGraph.error;
      // Capture starts only after authorization (so a lost ack cannot strand a live mic), but it is
      // deliberately NOT a prerequisite for the independent receive branch below.
      const micResult = outcome(this.deps.getMic(this.micOpts()));

      // ② After authorization, start the independent SFU sessions together. Cloudflare maps each
      // session to its own PeerConnection, so only operations WITHIN one session stay serialized.
      const publish = this.deps.createPublish(serverId, selfId);
      this.publish = publish;
      const pull = this.deps.createPull(serverId);
      this.pull = pull;
      this.unsubTrack = pull.onTrack((tn, _t, stream) => this.onPulledTrack(tn, stream));

      const receiveReady = outcome(
        (async () => {
          await pull.connect();
          this.unsubPullFailed =
            pull.onConnectionRecoveryNeeded?.(() => this.recoverMediaSessions()) ?? null;
          const remoteMembers = roomStore(serverId)
            .getState()
            .voice.members.filter((m) => m.userId !== selfId);
          // v2 explicitly advertises 0 while this person is joining. A positive sequence is the
          // server's proof that their browser acknowledged a connected PeerConnection. The pull
          // session serializes the actual SFU mutations internally, while Promise.all observes every
          // requested mic and surfaces any failed addition before join completes.
          await Promise.all(
            remoteMembers
              .filter((member) => (member.micSeq ?? 0) > 0)
              .map((member) => this.pullMic(member.userId, member.micSeq ?? 0)),
          );
        })(),
      );

      const sendReady = outcome(
        (async () => {
          const publishConnected = outcome(publish.connect());
          const [connected, captured] = await Promise.all([publishConnected, micResult]);
          if (!connected.ok) {
            if (captured.ok) captured.value.stop();
            throw connected.error;
          }
          if (!captured.ok) throw captured.error;
          const mic = captured.value;
          // A pre-call mute must take effect before the track is offered to the publish session.
          mic.enabled = !this.effectiveMuted();
          this.localMic = mic;
          const { trackName } = await publish.publishMic(mic);
          this.micTrackName = trackName;
          this.applyMuteState();
          this.deps.graph.attachLocalMic(mic);
          this.startSpeaking(selfId, this.deps.graph.getLocalAnalyser());
          this.unsubPublishFailed =
            publish.onConnectionRecoveryNeeded?.(() => this.recoverMediaSessions()) ?? null;
        })(),
      );

      // Both branches must settle before failure teardown. On the normal path, receiveReady can
      // attach and play remote tracks while sendReady is still waiting on permission/model loading.
      const [received, sent] = await Promise.all([receiveReady, sendReady]);
      if (!received.ok) throw received.error;
      if (!sent.ok) throw sent.error;

      // The server starts the member unmuted. Publish an explicit initial state only when an idle
      // control changed it, after the graph, local track, and room membership are all ready.
      if (this.effectiveMuted()) this.sendVoiceState();

      this.unsubReconnect = ws.on("hello.ok", () => void this.onReconnect());
      // FR-36: play soundboard broadcasts for EVERY in-voice member, not only those who opened the
      // soundboard panel. The frame is self-contained (trims included) so playback needs no query cache;
      // playSoundboard re-guards inVoice + !deafened. Torn down with the rest of the join in teardown().
      this.unsubSoundPlayed = ws.on("sound.played", (m) => {
        void this.playSoundboard(serverId, {
          id: m.soundId,
          trimStartMs: m.trimStartMs,
          trimEndMs: m.trimEndMs,
          gain: m.gain,
        });
      });
      this.unsubSoundStopped = ws.on("sound.stopped", (message) => {
        this.soundboard?.player.stop(message.soundId);
      });
      useMediaStore.getState().setVoiceStatus("joined");
      this.soundEffectsReady = true;
      this.voiceMemberIds.clear();
      for (const member of roomStore(serverId).getState().voice.members) {
        this.voiceMemberIds.add(member.userId);
      }
      this.streamTrackNames.clear();
      for (const stream of roomStore(serverId).getState().streams) {
        this.streamTrackNames.add(stream.trackName);
      }
      if (opts.announceSelf !== false && !this.deafened) playUiSound("voice.join");
    } catch (err) {
      await this.teardown();
      // voice.join may already have registered us in the roster (any later step can be the failure),
      // so a failed join must not leave a ghost member — best-effort server-side leave.
      try {
        ws.send({ t: "voice.leave" });
      } catch {
        // Socket not open — the join frame never reached the server, nothing to undo.
      }
      this.resetSession();
      const m = useMediaStore.getState();
      m.setVoiceStatus("error");
      m.setInVoiceServerId(null);
      throw err;
    }
  }

  async leave(): Promise<void> {
    if (this.serverId === null) return;
    const ws = this.ws;
    if (!this.deafened) playUiSound("voice.leave");
    useMediaStore.getState().setVoiceStatus("leaving");
    // Reverse teardown FIRST (close sessions/graph while still authorized in voice), THEN voice.leave.
    await this.teardown();
    ws?.send({ t: "voice.leave" });
    this.resetSession();
    this.clearVoicePreferences();
    const media = useMediaStore.getState();
    media.setVoiceStatus("idle");
    media.setInVoiceServerId(null);
    media.setMuted(false);
    media.setDeafened(false);
    media.clearSpeaking();
  }

  // A reconnect inside the server's voice lease keeps healthy media sessions. If the lease expired
  // (self absent from the fresh snapshot) or either transport failed, the shared single-flight
  // recovery path rebuilds and restores mute/deafen state.
  private onReconnect(): void {
    const serverId = this.serverId;
    if (serverId === null || useMediaStore.getState().voiceStatus !== "joined") return;
    const selfStillInVoice = roomStore(serverId)
      .getState()
      .voice.members.some((member) => member.userId === this.selfId());
    const publishState = this.publish?.state;
    const pullState = this.pull?.state;
    const publishHealthy =
      this.publish !== null &&
      (publishState === undefined ||
        publishState === "connected" ||
        publishState === "renegotiating");
    const pullHealthy =
      this.pull !== null &&
      (pullState === undefined || pullState === "connected" || pullState === "renegotiating");
    if (selfStillInVoice && publishHealthy && pullHealthy) return;
    this.recoverMediaSessions();
  }

  setMuted(muted: boolean): void {
    this.userMuted = muted;
    this.applyMuteState();
    this.sendVoiceState();
    useMediaStore.getState().setMuted(this.effectiveMuted());
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    this.applyDeafenState();
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
    const muted = useSettingsStore.getState().volumes.soundboardMuted ?? false;
    this.deps.graph.setSoundboardGain(muted ? 0 : gain);
  }

  // FR-36: play a sound locally ONLY when in voice on THIS server and not deafened (non-voice members
  // and deafened members never hear it — they only bump the badge, done by the sounds hook). The player
  // is built lazily per voice server; a test harness without the factory makes this a no-op.
  async playSoundboard(
    serverId: string,
    sound: { id: string; trimStartMs: number; trimEndMs: number; gain: number },
  ): Promise<void> {
    const media = useMediaStore.getState();
    if (media.inVoiceServerId !== serverId || media.voiceStatus !== "joined") return;
    if (this.deafened) return;
    const player = this.ensureSoundboard(serverId);
    if (player) await player.play(sound, "shared");
  }

  async previewSoundboard(
    serverId: string,
    sound: { id: string; trimStartMs: number; trimEndMs: number; gain: number },
  ): Promise<void> {
    await this.preparePreviewGraph();
    const player = this.ensureSoundboard(serverId);
    if (player === null) return;
    await player.play(sound, "local-preview");
  }

  async previewSoundFile(
    serverId: string,
    bytes: ArrayBuffer,
    sound: { trimStartMs: number; trimEndMs: number; gain: number },
    onStarted?: () => void,
  ): Promise<void> {
    await this.preparePreviewGraph();
    const player = this.ensureSoundboard(serverId);
    if (player === null) return;
    player.stopPreview();
    await player.playBytes(
      bytes,
      { id: "sound-editor-preview", ...sound },
      "editor-preview",
      onStarted,
    );
  }

  stopSoundboardPreview(soundId?: string): void {
    this.soundboard?.player.stopPreview(soundId);
  }

  stopSoundboardSound(soundId: string): void {
    this.soundboard?.player.stop(soundId);
  }

  private async preparePreviewGraph(): Promise<void> {
    const prefs = useMediaStore.getState().deviceSelection;
    await this.deps.graph.init(prefs.sinkId);
    await this.resumeGraph();
    const volumes = useSettingsStore.getState().volumes;
    this.deps.graph.setSoundboardGain(volumes.soundboardMuted ? 0 : volumes.soundboard);
  }

  private ensureSoundboard(serverId: string): SoundboardLike | null {
    if (this.soundboard?.serverId === serverId) return this.soundboard.player;
    this.soundboard?.player.stopPreview();
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

  // Autoplay policy: ctx.resume() resolves instantly inside a join-click gesture, but the refresh
  // auto-resume path (voiceResume.ts) has NO gesture — Chrome then parks the resume() promise until
  // the next user activation, and awaiting it would hang the rejoin at step ②. Race a short
  // deadline; when blocked, continue the join (publish/pull wire fine on a suspended context) and
  // arm one-time gesture listeners so the first click/keypress unblocks graph output + the WASM mic
  // worklet modes.
  private async resumeGraph(): Promise<void> {
    const resumed = this.deps.graph.resume().then(() => "ok" as const);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const blocked = new Promise<"blocked">((resolve) => {
      timer = setTimeout(() => resolve("blocked"), 500);
    });
    const result = await Promise.race([resumed, blocked]);
    if (timer !== null) clearTimeout(timer);
    if (result === "ok") return;
    // The parked promise may still reject much later (context closed by teardown) — not actionable.
    resumed.catch(() => undefined);
    const retry = (): void => void this.deps.graph.resume();
    window.addEventListener("pointerdown", retry, { once: true });
    window.addEventListener("keydown", retry, { once: true });
  }

  private micOpts(): MicOpts {
    const prefs = useMediaStore.getState().deviceSelection;
    // instanceof narrows GraphLike → AudioGraph without a cast (§9.1, recorderInputs precedent);
    // unit-test fake graphs are not AudioGraphs, so tests exercise the no-context path.
    const graph = this.deps.graph;
    const ctx = graph instanceof AudioGraph ? graph.micProcessingContext() : null;
    return {
      ...(prefs.micId ? { deviceId: prefs.micId } : {}),
      noiseSuppression: prefs.noiseSuppression,
      ...(prefs.deepfilterAtten !== undefined ? { deepfilterAtten: prefs.deepfilterAtten } : {}),
      ...(prefs.autoGainControl !== undefined ? { autoGainControl: prefs.autoGainControl } : {}),
      ...(ctx ? { audioContext: ctx } : {}),
    };
  }

  private effectiveMuted(): boolean {
    return this.deafened || this.userMuted;
  }

  private applyDeafenState(): void {
    if (this.graphReady) this.deps.graph.setDeafened(this.deafened);
  }

  private applyMuteState(): void {
    if (this.publish && this.micTrackName !== null)
      this.publish.setTrackEnabled(this.micTrackName, !this.effectiveMuted());
  }

  private sendVoiceState(): void {
    if (!this.voiceStateReady || this.ws === null) return;
    this.ws.send({ t: "voice.state", muted: this.effectiveMuted(), deafened: this.deafened });
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

  private onStreamAdded(trackName: string): void {
    const isNew = !this.streamTrackNames.has(trackName);
    this.streamTrackNames.add(trackName);
    if (this.soundEffectsReady && isNew && !this.deafened) playUiSound("stream.start");
  }

  private onStreamRemoved(trackName: string): void {
    const wasKnown = this.streamTrackNames.delete(trackName);
    if (this.soundEffectsReady && wasKnown && !this.deafened) playUiSound("stream.stop");
  }

  private onVoiceState(members: VoiceMember[]): void {
    const selfId = this.selfId();
    const ids = new Set(members.map((m) => m.userId));
    if (this.soundEffectsReady) {
      for (const id of ids) {
        if (!this.voiceMemberIds.has(id) && id !== selfId && !this.deafened)
          playUiSound("voice.join");
      }
      for (const id of this.voiceMemberIds) {
        if (!ids.has(id) && id !== selfId && !this.deafened) playUiSound("voice.leave");
      }
    }
    this.voiceMemberIds.clear();
    for (const id of ids) this.voiceMemberIds.add(id);
    for (const m of members) {
      if (m.userId === selfId) continue;
      const seq = m.micSeq ?? 0;
      if (seq === 0) continue;
      if (!this.pulledMics.has(m.userId)) {
        void this.pullMic(m.userId, seq).catch((error: unknown) => {
          console.error("confirmed mic pull failed; rebuilding media sessions", {
            userId: m.userId,
            error,
          });
          this.recoverMediaSessions();
        });
      } else if (this.micSeqs.get(m.userId) !== seq) {
        void this.repullMic(m.userId, seq).catch((error: unknown) => {
          console.error("confirmed mic re-pull failed; rebuilding media sessions", {
            userId: m.userId,
            error,
          });
          this.recoverMediaSessions();
        });
      }
    }
    for (const id of Array.from(this.pulledMics)) {
      if (ids.has(id)) continue;
      this.pulledMics.delete(id);
      this.micSeqs.delete(id);
      void this.pull?.removeRemoteTracks([micTrackName(id)]);
      this.deps.graph.detachRemoteMic(id);
      this.stopSpeaking(id);
      useMediaStore.getState().setSpeaking(id, false);
    }
  }

  // Only a positive micSeq can enter this path: it was committed after the publisher's browser was
  // connected, so one exact pull is sufficient. A failure is a real session fault, not a timing race.
  private async pullMic(id: string, seq: number): Promise<void> {
    const pull = this.pull;
    if (pull === null) return;
    await pull.addRemoteTracks([{ trackName: micTrackName(id) }]);
    if (this.pull !== pull || !this.voiceMemberIds.has(id)) return;
    this.pulledMics.add(id);
    this.micSeqs.set(id, seq);
  }

  // micSeq bump: tear the old pull down (graph detach + tracks/close) and pull the mic fresh. The
  // remove is queued on the SAME pull session as any in-flight add, so it always closes what the
  // add mapped — then the committed generation negotiates a new mid exactly once.
  private async repullMic(id: string, seq: number): Promise<void> {
    this.deps.graph.detachRemoteMic(id);
    this.stopSpeaking(id);
    useMediaStore.getState().setSpeaking(id, false);
    const pull = this.pull;
    if (pull === null) return;
    await pull.removeRemoteTracks([micTrackName(id)]);
    this.pulledMics.delete(id);
    this.micSeqs.delete(id);
    if (this.pull === pull && this.voiceMemberIds.has(id)) await this.pullMic(id, seq);
  }

  // Connectivity is already back when the recovered-transport signal fires, so rebuild immediately.
  // The single-flight guard collapses publish+pull events from the same interruption.
  private recoverMediaSessions(): void {
    if (this.recovering || useMediaStore.getState().voiceStatus !== "joined") return;
    const serverId = this.serverId;
    if (serverId === null) return;
    this.recovering = true;
    void (async () => {
      try {
        if (useMediaStore.getState().voiceStatus !== "joined") return;
        await this.teardown();
        await this.doJoin(serverId, { announceSelf: false });
      } catch {
        // doJoin already surfaced the failure (voiceStatus 'error', ghost-leave sent).
      } finally {
        this.recovering = false;
      }
    })();
  }

  private startSpeaking(userId: string, analyser: AnalyserNode | null): void {
    if (!analyser) {
      clearVoiceLevel(userId);
      return;
    }
    this.stopSpeaking(userId);
    this.speakingSubs.set(
      userId,
      this.deps.watchSpeaking(analyser, (sp) => useMediaStore.getState().setSpeaking(userId, sp), {
        onLevel: (level) => setVoiceLevel(userId, level),
      }),
    );
  }

  private stopSpeaking(userId: string): void {
    this.speakingSubs.get(userId)?.();
    this.speakingSubs.delete(userId);
    clearVoiceLevel(userId);
  }

  private waitForSelfInVoice(ws: WsLike, selfId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const unsub = ws.on("voice.state", (m) => {
        if (m.voice.members.some((mem) => mem.userId === selfId)) {
          unsub();
          unsubError();
          resolve();
        }
      });
      const unsubError = ws.on("error", (m) => {
        if (m.code !== "voice_client_update_required") return;
        unsub();
        unsubError();
        reject(new Error("A Tavern update is required before joining voice."));
      });
    });
  }

  private async teardown(): Promise<void> {
    this.voiceStateReady = false;
    // FR-36: cut any in-flight soundboard audio on voice leave, then drop the per-server player.
    this.soundboard?.player.stopAll();
    this.soundboard?.player.stopPreview();
    this.soundboard = null;
    this.unsubVoiceState?.();
    this.unsubReconnect?.();
    this.unsubTrack?.();
    this.unsubStreamAdded?.();
    this.unsubStreamRemoved?.();
    this.unsubSoundPlayed?.();
    this.unsubSoundStopped?.();
    this.unsubPublishFailed?.();
    this.unsubPullFailed?.();
    this.unsubVoiceState = null;
    this.unsubReconnect = null;
    this.unsubTrack = null;
    this.unsubStreamAdded = null;
    this.unsubStreamRemoved = null;
    this.unsubSoundPlayed = null;
    this.unsubSoundStopped = null;
    this.unsubPublishFailed = null;
    this.unsubPullFailed = null;
    for (const stop of this.speakingSubs.values()) stop();
    this.speakingSubs.clear();
    clearVoiceLevels();
    for (const id of this.pulledMics) this.deps.graph.detachRemoteMic(id);
    this.pulledMics.clear();
    this.micSeqs.clear();
    this.voiceMemberIds.clear();
    this.streamTrackNames.clear();
    this.soundEffectsReady = false;
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

  // S8.2: watched-stream tiles route their audio (attach) + volume (setStreamVolume) through the SAME
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

  // Per-trackName inbound audio bytes of the voice pull (§10 @realtime pairwise regression: every
  // member's bytes from EVERY other member grow — the aggregate hides a one-way-deaf pair).
  voiceStatsByTrackForTest(): Promise<Record<string, number>> {
    return this.pull?.inboundAudioBytesByTrack?.() ?? Promise.resolve({});
  }

  // The userIds whose remote mics are LIVE in the audio graph — the mock-SFU e2e's pairwise wiring
  // truth (no media plane there, so getStats is useless; a graph attach proves the pull negotiated
  // and the track event fired). instanceof narrows like recorderInputs (§9.1); unit-test fake
  // graphs are not AudioGraphs and read [].
  remoteMicUserIdsForTest(): string[] {
    const graph = this.deps.graph;
    return graph instanceof AudioGraph ? graph.remoteMicUserIds() : [];
  }

  outboundVideoStatsForTest(trackName: string): Promise<OutboundVideoLayer[]> {
    return this.publish?.outboundVideoStats?.(trackName) ?? Promise.resolve([]);
  }

  private resetSession(): void {
    if (this.serverId !== null) clearMediaOwner(this.serverId);
    this.ws = null;
    this.serverId = null;
    this.voiceStateReady = false;
  }

  private clearVoicePreferences(): void {
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
    voiceStatsByTrack: () => controller.voiceStatsByTrackForTest(),
    remoteMicUserIds: () => controller.remoteMicUserIdsForTest(),
    outboundVideoStats: (trackName) => controller.outboundVideoStatsForTest(trackName),
  });
  return controller;
}
