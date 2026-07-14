import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ScreenRid, ServerMessage, VoiceMember } from "@tavern/shared";
import { VoiceController, VoiceElsewhereError } from "@/features/voice/voiceController";
import type { VoiceDeps } from "@/features/voice/voiceController";
import { playUiSound } from "@/lib/uiSounds";
import { MEDIA_OWNER_STORAGE_KEY } from "@/lib/mediaOwnership";
import type { SpeakingOpts } from "@/media/levelMeter";
import { clearVoiceLevels, readVoiceLevel } from "@/media/voiceLevelBus";
import { useMediaStore } from "@/stores/media";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { fakeStream, fakeTrack } from "../fakes/media";

vi.mock("@/lib/uiSounds", () => ({
  playUiSound: vi.fn(),
  primeUiSounds: vi.fn(() => () => undefined),
}));

const SELF = "11111111-1111-1111-1111-111111111111";
const REMOTE = "22222222-2222-2222-2222-222222222222";
const REMOTE2 = "33333333-3333-3333-3333-333333333333";

function zeroPoints() {
  return {
    balance: 0,
    pendingPollWinnings: 0,
    currentRatePerMinute: 0,
    activeSources: [],
    today: { day: "2026-07-13", conversation: 0, streaming: 0, watching: 0, total: 0 },
    config: {
      enabled: true,
      basePointsPerMinute: 5,
      streamerBonusPerMinute: 5,
      watcherBonusPerMinute: 5,
      dailyCap: null,
    },
  };
}

function helloSnapshot(
  serverId: string,
  voiceMembers: VoiceMember[],
): Extract<ServerMessage, { t: "hello.ok" }> {
  return {
    t: "hello.ok",
    status: "",
    self: { userId: SELF, username: "self", displayName: "Self", color: "#123456" },
    serverMeta: { id: serverId, nickname: "cave", adminUserId: SELF },
    members: [],
    voice: {
      members: voiceMembers,
      sessionStartedAt: voiceMembers.length > 0 ? 500 : null,
    },
    streams: [],
    recording: { active: false },
    lastMessageId: null,
    lastReadMessageId: 0,
    firstUnreadMessageId: null,
    unreadCount: 0,
    costStatus: { usedGB: 0, capGB: 900, blocked: false },
    polls: [],
    points: zeroPoints(),
  };
}

const analyser = {} as unknown as AnalyserNode;

class FakePublish {
  readonly log: string[];
  readonly userId: string;
  connected = false;
  closed = false;
  readonly enabled: Array<[string, boolean]> = [];
  readonly sender = { replaceTrack: vi.fn(async () => undefined) } as unknown as RTCRtpSender;
  constructor(log: string[], userId: string) {
    this.log = log;
    this.userId = userId;
  }
  async connect(): Promise<void> {
    this.log.push("publish.connect");
    this.connected = true;
  }
  async publishMic(_track: MediaStreamTrack): Promise<{ trackName: string }> {
    this.log.push("publish.publishMic");
    return { trackName: `mic:${this.userId}` };
  }
  recoveryNeeded: (() => void) | null = null;
  onConnectionRecoveryNeeded(cb: () => void): () => void {
    this.recoveryNeeded = cb;
    return () => {
      this.recoveryNeeded = null;
    };
  }
  // Screen share (S8.1) publishes on this shared session; unused by the voice-only tests here.
  async publishStream(): Promise<{ videoTrackName: string; audioTrackName?: string }> {
    this.log.push("publish.publishStream");
    return { videoTrackName: `screen:${this.userId}:1` };
  }
  // Webcam (S8.3) publishes on this shared session; unused by the voice-only tests here.
  async publishCam(_track: MediaStreamTrack): Promise<{ trackName: string }> {
    this.log.push("publish.publishCam");
    return { trackName: `cam:${this.userId}` };
  }
  async unpublish(names: string[]): Promise<void> {
    this.log.push(`publish.unpublish:${names.join(",")}`);
  }
  micSender(): RTCRtpSender | null {
    return this.sender;
  }
  camSender(): RTCRtpSender | null {
    return this.sender;
  }
  setTrackEnabled(name: string, enabled: boolean): void {
    this.log.push(`publish.setEnabled:${enabled}`);
    this.enabled.push([name, enabled]);
  }
  async setPreset(name: string, preset: string): Promise<void> {
    this.log.push(`publish.setPreset:${name}:${preset}`);
  }
  async replaceScreenTrack(): Promise<void> {
    this.log.push("publish.replaceScreenTrack");
  }
  async close(): Promise<void> {
    this.log.push("publish.close");
    this.closed = true;
  }
}

class FakePull {
  readonly log: string[];
  connected = false;
  closed = false;
  readonly added: Array<Array<{ trackName: string; preferredRid?: ScreenRid }>> = [];
  readonly removed: string[][] = [];
  // Captured media-recovery listener — tests fire it directly.
  recoveryNeeded: (() => void) | null = null;
  private trackCb:
    | ((trackName: string, track: MediaStreamTrack, stream: MediaStream) => void)
    | null = null;
  constructor(log: string[]) {
    this.log = log;
  }
  async connect(): Promise<void> {
    this.log.push("pull.connect");
    this.connected = true;
  }
  onTrack(
    cb: (trackName: string, track: MediaStreamTrack, stream: MediaStream) => void,
  ): () => void {
    this.trackCb = cb;
    return () => undefined;
  }
  emitTrack(trackName: string): void {
    this.trackCb?.(trackName, fakeTrack("audio"), fakeStream());
  }
  onConnectionRecoveryNeeded(cb: () => void): () => void {
    this.recoveryNeeded = cb;
    return () => {
      this.recoveryNeeded = null;
    };
  }
  async addRemoteTracks(
    tracks: Array<{ trackName: string; preferredRid?: ScreenRid }>,
  ): Promise<void> {
    this.log.push("pull.addRemoteTracks");
    this.added.push(tracks);
  }
  async removeRemoteTracks(names: string[]): Promise<void> {
    this.log.push("pull.removeRemoteTracks");
    this.removed.push(names);
  }
  async close(): Promise<void> {
    this.log.push("pull.close");
    this.closed = true;
  }
}

class FakeGraph {
  readonly log: string[];
  closed = false;
  deafened = false;
  sink: string | null = null;
  localAttachCount = 0;
  readonly userGains = new Map<string, number>();
  readonly streamVolumes = new Map<string, number>();
  readonly detached: string[] = [];
  private readonly attached = new Set<string>();
  constructor(log: string[]) {
    this.log = log;
  }
  async init(sinkId?: string): Promise<void> {
    this.log.push("graph.init");
    this.sink = sinkId ?? null;
  }
  async resume(): Promise<void> {
    this.log.push("graph.resume");
  }
  attachLocalMic(_track: MediaStreamTrack): void {
    this.log.push("graph.attachLocalMic");
    this.localAttachCount += 1;
  }
  attachRemoteMic(userId: string): void {
    this.log.push(`graph.attachRemote:${userId}`);
    this.attached.add(userId);
  }
  detachRemoteMic(userId: string): void {
    this.log.push(`graph.detach:${userId}`);
    this.detached.push(userId);
  }
  setUserGain(userId: string, gain: number): void {
    this.userGains.set(userId, gain);
  }
  // S8.2 stream-audio sink (widened GraphLike) — watched-stream audio + volume route through here.
  attachStreamAudio(streamKey: string, _stream: MediaStream): void {
    this.log.push(`graph.attachStream:${streamKey}`);
  }
  detachStreamAudio(streamKey: string): void {
    this.log.push(`graph.detachStream:${streamKey}`);
  }
  setStreamVolume(streamKey: string, level: number): void {
    this.streamVolumes.set(streamKey, level);
  }
  setDeafened(deafened: boolean): void {
    this.log.push(`graph.setDeafened:${deafened}`);
    this.deafened = deafened;
  }
  soundboardGain = 1;
  setSoundboardGain(gain: number): void {
    this.soundboardGain = gain;
  }
  async setSink(deviceId: string): Promise<void> {
    this.log.push(`graph.setSink:${deviceId}`);
    this.sink = deviceId;
  }
  getUserAnalyser(userId: string): AnalyserNode | null {
    return this.attached.has(userId) ? analyser : null;
  }
  getLocalAnalyser(): AnalyserNode | null {
    return analyser;
  }
  async close(): Promise<void> {
    this.log.push("graph.close");
    this.closed = true;
  }
}

class FakeWs {
  readonly sent: ClientMessage[] = [];
  readonly log: string[];
  ackMembers: VoiceMember[] = [];
  autoAck = true;
  private readonly listeners = new Map<string, Set<(m: ServerMessage) => void>>();
  constructor(log: string[]) {
    this.log = log;
  }
  send(msg: ClientMessage): void {
    this.sent.push(msg);
    this.log.push(`ws.${msg.t}`);
    if (msg.t === "voice.join" && this.autoAck) this.ack();
  }
  ack(): void {
    const members: VoiceMember[] = [
      { userId: SELF, muted: false, deafened: false },
      ...this.ackMembers,
    ];
    this.emit({ t: "voice.state", voice: { members, sessionStartedAt: 1000 }, at: 2000 });
  }
  on<T extends ServerMessage["t"]>(
    t: T,
    cb: (m: Extract<ServerMessage, { t: T }>) => void,
  ): () => void {
    const set = this.listeners.get(t) ?? new Set<(m: ServerMessage) => void>();
    const wrapped = (m: ServerMessage): void => {
      if (m.t === t) cb(m as Extract<ServerMessage, { t: T }>);
    };
    set.add(wrapped);
    this.listeners.set(t, set);
    return () => {
      set.delete(wrapped);
    };
  }
  emit(m: ServerMessage): void {
    const set = this.listeners.get(m.t);
    if (set) for (const cb of Array.from(set)) cb(m);
  }
}

function makeHarness() {
  const log: string[] = [];
  const publishes: FakePublish[] = [];
  const pulls: FakePull[] = [];
  const graph = new FakeGraph(log);
  const ws = new FakeWs(log);
  const localMic = fakeTrack("audio");
  const nextMic = fakeTrack("audio");
  const getMic = vi.fn(async () => {
    log.push("getMic");
    return localMic;
  });
  const retoggleMic = vi.fn(async () => nextMic);
  let levelSink: ((level: number) => void) | null = null;
  const watchSpeaking = vi.fn(
    (_analyser: AnalyserNode, _cb: (speaking: boolean) => void, opts?: SpeakingOpts) => {
      levelSink = opts?.onLevel ?? null;
      return () => opts?.onLevel?.(0);
    },
  );
  const deps: VoiceDeps = {
    graph,
    createPublish: (_serverId, userId) => {
      const p = new FakePublish(log, userId);
      publishes.push(p);
      return p;
    },
    createPull: () => {
      const p = new FakePull(log);
      pulls.push(p);
      return p;
    },
    wsFor: () => ws,
    getMic,
    retoggleMic,
    watchSpeaking,
  };
  return {
    log,
    publishes,
    pulls,
    graph,
    ws,
    getMic,
    retoggleMic,
    watchSpeaking,
    deps,
    localMic,
    emitVoiceLevel(level: number) {
      if (levelSink === null) throw new Error("speaking watcher was not started");
      levelSink(level);
    },
  };
}

function seedVoice(serverId: string, members: VoiceMember[]): void {
  roomStore(serverId).getState().apply(helloSnapshot(serverId, members));
}

function seedHarnessVoice(
  harness: ReturnType<typeof makeHarness>,
  serverId: string,
  members: VoiceMember[],
): void {
  harness.ws.ackMembers = members;
  seedVoice(serverId, members);
}

async function flush(): Promise<void> {
  // Drain ~25 microtask turns (a chained then-ladder, no await-in-loop) so the fire-and-forget
  // reconnect rejoin settles before assertions.
  await Array.from({ length: 25 }).reduce<Promise<void>>(
    (p) => p.then(() => undefined),
    Promise.resolve(),
  );
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolver: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolver === null) throw new Error("deferred resolver was not initialized");
      resolver(value);
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetRoomStores();
  vi.mocked(playUiSound).mockClear();
  useSessionStore.setState({
    status: "authed",
    profile: { userId: SELF, username: "self", displayName: "Self", color: "#123456" },
  });
  useMediaStore.setState({
    voiceStatus: "idle",
    inVoiceServerId: null,
    muted: false,
    deafened: false,
    speakingUserIds: new Set<string>(),
    deviceSelection: { noiseSuppression: "standard" },
  });
  useSettingsStore.setState({
    volumes: { v: 1, users: {}, streams: {}, soundboard: 1, mutedUsers: [] },
  });
  clearVoiceLevels();
});

describe("FR-18 join/leave", () => {
  it("join sends voice.join and waits for its ack before either rtc session", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    h.ws.autoAck = false;

    const joined = controller.join("A");
    await flush();

    expect(h.log[0]).toBe("ws.voice.join");
    expect(h.log).toContain("graph.init");
    expect(h.log).not.toContain("getMic");
    expect(h.log).not.toContain("publish.connect");
    expect(h.log).not.toContain("pull.connect");

    h.ws.ack();
    await joined;

    expect(h.log).toContain("publish.connect");
    expect(h.log).toContain("pull.connect");
    expect(useMediaStore.getState().voiceStatus).toBe("joined");
    expect(useMediaStore.getState().inVoiceServerId).toBe("A");
    // No browser media is restored after reload. The only persisted value identifies which stale
    // tab-owned server lifetime a replacement document must clear.
    expect(sessionStorage.getItem("tavern.voiceSession.v1")).toBeNull();
    expect(sessionStorage.getItem(MEDIA_OWNER_STORAGE_KEY)).toBe("A");
  });

  it("routes the analyser level to the animation bus and clears it on leave", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");

    h.emitVoiceLevel(0.72);
    expect(readVoiceLevel(SELF)).toBe(0.72);

    await controller.leave();
    expect(readVoiceLevel(SELF)).toBe(0);
    expect(sessionStorage.getItem(MEDIA_OWNER_STORAGE_KEY)).toBeNull();
  });

  it("a slow microphone does not block receiving and attaching existing remote audio", async () => {
    const h = makeHarness();
    const mic = deferred<MediaStreamTrack>();
    h.deps.getMic = vi.fn(() => mic.promise);
    const controller = new VoiceController(h.deps);
    seedHarnessVoice(h, "A", [{ userId: REMOTE, muted: false, deafened: false, micSeq: 1 }]);

    const joined = controller.join("A");
    await flush();

    expect(h.pulls[0]?.added).toEqual([[{ trackName: `mic:${REMOTE}` }]]);
    expect(h.log).not.toContain("publish.publishMic");
    expect(useMediaStore.getState().voiceStatus).toBe("joining");

    h.pulls[0]?.emitTrack(`mic:${REMOTE}`);
    expect(h.log).toContain(`graph.attachRemote:${REMOTE}`);

    mic.resolve(h.localMic);
    await joined;
    expect(h.log).toContain("publish.publishMic");
    expect(useMediaStore.getState().voiceStatus).toBe("joined");
  });

  it("a slow receive connection does not block publishing the local microphone", async () => {
    const h = makeHarness();
    const pullConnected = deferred<void>();
    h.deps.createPull = () => {
      const pull = new FakePull(h.log);
      pull.connect = async () => {
        h.log.push("pull.connect");
        await pullConnected.promise;
        pull.connected = true;
      };
      h.pulls.push(pull);
      return pull;
    };
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);

    const joined = controller.join("A");
    await flush();

    expect(h.log).toContain("publish.publishMic");
    expect(useMediaStore.getState().voiceStatus).toBe("joining");

    pullConnected.resolve();
    await joined;
    expect(useMediaStore.getState().voiceStatus).toBe("joined");
  });

  it("waits for the committed mic generation instead of retrying an unready publisher", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");
    const pull = h.pulls[0];
    if (!pull) throw new Error("expected the voice pull session");

    h.ws.emit({
      t: "voice.state",
      voice: {
        members: [
          { userId: SELF, muted: false, deafened: false, micSeq: 1 },
          { userId: REMOTE, muted: false, deafened: false, micSeq: 0 },
        ],
        sessionStartedAt: 1000,
      },
      at: 3000,
    });
    await flush();
    expect(pull.added).toEqual([]);

    h.ws.emit({
      t: "voice.state",
      voice: {
        members: [
          { userId: SELF, muted: false, deafened: false, micSeq: 1 },
          { userId: REMOTE, muted: false, deafened: false, micSeq: 1 },
        ],
        sessionStartedAt: 1000,
      },
      at: 4000,
    });
    await flush();
    expect(pull.added).toEqual([[{ trackName: `mic:${REMOTE}` }]]);
  });

  it("streamAudioSink is null until joined, the graph while joined, null after leave (S8.2)", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);

    expect(controller.streamAudioSink()).toBeNull();
    await controller.join("A");
    expect(controller.streamAudioSink()).toBe(h.graph);
    // The sink routes a watched-stream volume level to the SAME graph (FR-31).
    controller.streamAudioSink()?.setStreamVolume("uuu:screen", 2);
    expect(h.graph.streamVolumes.get("uuu:screen")).toBe(2);

    await controller.leave();
    expect(controller.streamAudioSink()).toBeNull();
  });

  it("leave tears down sessions, graph detaches, sends voice.leave", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedHarnessVoice(h, "A", [{ userId: REMOTE, muted: false, deafened: false, micSeq: 1 }]);
    await controller.join("A");

    await controller.leave();

    expect(h.pulls[0]?.closed).toBe(true);
    expect(h.publishes[0]?.closed).toBe(true);
    expect(h.graph.closed).toBe(true);
    expect(h.graph.detached).toContain(REMOTE);
    expect(h.ws.sent.some((m) => m.t === "voice.leave")).toBe(true);
    expect(useMediaStore.getState().voiceStatus).toBe("idle");
    expect(useMediaStore.getState().inVoiceServerId).toBeNull();
    expect(vi.mocked(playUiSound).mock.calls.some(([kind]) => kind === "voice.leave")).toBe(true);
  });

  it("plays sounds for join/leave and stream changes, but not reconnect joins", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedHarnessVoice(h, "A", [{ userId: REMOTE, muted: false, deafened: false, micSeq: 1 }]);

    await controller.join("A");
    expect(vi.mocked(playUiSound)).toHaveBeenCalledWith("voice.join");
    vi.mocked(playUiSound).mockClear();

    h.ws.emit({
      t: "voice.state",
      voice: {
        members: [
          { userId: SELF, muted: false, deafened: false },
          { userId: REMOTE, muted: false, deafened: false },
          { userId: REMOTE2, muted: false, deafened: false },
        ],
        sessionStartedAt: 1000,
      },
      at: 2000,
    });
    expect(vi.mocked(playUiSound)).toHaveBeenCalledWith("voice.join");
    vi.mocked(playUiSound).mockClear();

    h.ws.emit({
      t: "voice.state",
      voice: {
        members: [
          { userId: SELF, muted: false, deafened: false },
          { userId: REMOTE2, muted: false, deafened: false },
        ],
        sessionStartedAt: 1000,
      },
      at: 3000,
    });
    expect(vi.mocked(playUiSound)).toHaveBeenCalledWith("voice.leave");
    vi.mocked(playUiSound).mockClear();

    h.ws.emit({
      t: "stream.added",
      stream: {
        trackName: "screen:22222222-2222-2222-2222-222222222222:1",
        kind: "screen",
        userId: REMOTE,
        hasAudio: false,
        preset: "1080p30",
      },
      at: 4000,
    });
    expect(vi.mocked(playUiSound)).toHaveBeenCalledWith("stream.start");
    vi.mocked(playUiSound).mockClear();

    h.ws.emit({
      t: "stream.removed",
      trackName: "screen:22222222-2222-2222-2222-222222222222:1",
      at: 5000,
    });
    expect(vi.mocked(playUiSound)).toHaveBeenCalledWith("stream.stop");
    vi.mocked(playUiSound).mockClear();
  });

  it("failed join (rtc step throws after the ack) sends voice.leave — no ghost roster member", async () => {
    const h = makeHarness();
    const deps: VoiceDeps = {
      ...h.deps,
      createPublish: (_serverId, userId) => {
        const p = new FakePublish(h.log, userId);
        p.connect = async () => {
          throw new Error("sfu 500");
        };
        return p;
      },
    };
    const controller = new VoiceController(deps);
    seedVoice("A", []);

    await expect(controller.join("A")).rejects.toThrow("sfu 500");

    // voice.join reached the server (roster registered us) — the failed join must undo it.
    expect(h.ws.sent.some((m) => m.t === "voice.join")).toBe(true);
    expect(h.ws.sent.some((m) => m.t === "voice.leave")).toBe(true);
    expect(useMediaStore.getState().voiceStatus).toBe("error");
    expect(useMediaStore.getState().inVoiceServerId).toBeNull();
    expect(h.graph.closed).toBe(true);
  });

  it("microphone failure after receive startup tears down both sessions and leaves voice", async () => {
    const h = makeHarness();
    h.deps.getMic = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const controller = new VoiceController(h.deps);
    seedHarnessVoice(h, "A", [{ userId: REMOTE, muted: false, deafened: false, micSeq: 1 }]);

    await expect(controller.join("A")).rejects.toMatchObject({ name: "NotAllowedError" });

    expect(h.pulls[0]?.added).toEqual([[{ trackName: `mic:${REMOTE}` }]]);
    expect(h.pulls[0]?.closed).toBe(true);
    expect(h.publishes[0]?.closed).toBe(true);
    expect(h.ws.sent.some((m) => m.t === "voice.leave")).toBe(true);
    expect(useMediaStore.getState().voiceStatus).toBe("error");
  });

  it("ws reconnect after the voice lease expired → teardown + rejoin", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");

    roomStore("A").getState().apply(helloSnapshot("A", []));
    h.ws.emit(helloSnapshot("A", []));
    await flush();

    expect(h.publishes).toHaveLength(2);
    expect(h.publishes[0]?.closed).toBe(true);
    expect(h.pulls).toHaveLength(2);
    expect(h.ws.sent.filter((m) => m.t === "voice.join")).toHaveLength(2);
    expect(useMediaStore.getState().voiceStatus).toBe("joined");
    expect(
      vi.mocked(playUiSound).mock.calls.filter(([kind]) => kind === "voice.join"),
    ).toHaveLength(1);
  });

  it("ws reconnect inside the voice lease keeps healthy media sessions", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");

    const retained: VoiceMember[] = [
      { userId: SELF, muted: false, deafened: false, mediaReadyVersion: 2 },
    ];
    roomStore("A").getState().apply(helloSnapshot("A", retained));
    h.ws.emit(helloSnapshot("A", retained));
    await flush();

    expect(h.publishes).toHaveLength(1);
    expect(h.publishes[0]?.closed).toBe(false);
    expect(h.pulls).toHaveLength(1);
    expect(h.pulls[0]?.closed).toBe(false);
  });
});

describe("FR-18 single-voice rule", () => {
  it("join while in voice elsewhere throws VoiceElsewhereError; confirm path leaves A then joins B", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    seedVoice("B", []);
    await controller.join("A");

    await expect(controller.join("B")).rejects.toBeInstanceOf(VoiceElsewhereError);
    await controller.join("B").catch((err) => {
      expect(err).toBeInstanceOf(VoiceElsewhereError);
      if (err instanceof VoiceElsewhereError) expect(err.serverId).toBe("A");
    });

    // Confirm path: leave A, then join B.
    await controller.leave();
    await controller.join("B");
    expect(useMediaStore.getState().inVoiceServerId).toBe("B");
    expect(useMediaStore.getState().voiceStatus).toBe("joined");
  });
});

describe("FR-26", () => {
  it("carries idle mute and deafen preferences into the next voice session", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);

    controller.setMuted(true);
    controller.setDeafened(true);
    expect(h.ws.sent).toEqual([]);
    expect(h.graph.deafened).toBe(false);
    expect(useMediaStore.getState().muted).toBe(true);
    expect(useMediaStore.getState().deafened).toBe(true);

    seedVoice("A", []);
    await controller.join("A");

    expect(h.localMic.enabled).toBe(false);
    expect(h.publishes[0]?.enabled).toContainEqual([`mic:${SELF}`, false]);
    expect(h.graph.deafened).toBe(true);
    expect(h.ws.sent.at(-1)).toEqual({ t: "voice.state", muted: true, deafened: true });
  });

  it("mute disables track, no replaceTrack(null), sends voice.state", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");

    controller.setMuted(true);

    const publish = h.publishes[0];
    expect(publish?.enabled).toContainEqual([`mic:${SELF}`, false]);
    expect(publish?.sender.replaceTrack).not.toHaveBeenCalled();
    const state = h.ws.sent.filter((m) => m.t === "voice.state");
    expect(state.at(-1)).toEqual({ t: "voice.state", muted: true, deafened: false });
    expect(useMediaStore.getState().muted).toBe(true);
  });

  it("deafen forces mute + graph.setDeafened; undeafen restores prior mute", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");

    controller.setDeafened(true);
    expect(h.graph.deafened).toBe(true);
    expect(h.publishes[0]?.enabled).toContainEqual([`mic:${SELF}`, false]);
    expect(h.ws.sent.at(-1)).toEqual({ t: "voice.state", muted: true, deafened: true });
    expect(useMediaStore.getState().muted).toBe(true);
    expect(useMediaStore.getState().deafened).toBe(true);

    controller.setDeafened(false);
    expect(h.graph.deafened).toBe(false);
    // prior mute was false → the mic track is re-enabled.
    expect(h.publishes[0]?.enabled.at(-1)).toEqual([`mic:${SELF}`, true]);
    expect(h.ws.sent.at(-1)).toEqual({ t: "voice.state", muted: false, deafened: false });
    expect(useMediaStore.getState().muted).toBe(false);
  });
});

describe("FR-22", () => {
  it("noise toggle mid-call → retoggleMic sequence", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");
    useMediaStore.getState().setDeviceSelection({ noiseSuppression: "off" });

    await controller.retoggleMic();

    expect(h.retoggleMic).toHaveBeenCalledWith(h.localMic, h.publishes[0]?.sender, {
      noiseSuppression: "off",
    });
    // the reacquired track is re-attached to the graph analyser (2× total: join + retoggle).
    expect(h.graph.localAttachCount).toBe(2);
  });
});

describe("FR-21", () => {
  it("sink change → graph.setSink; mic change → retoggleMic", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");

    await controller.setSink("sink-2");
    expect(h.graph.sink).toBe("sink-2");

    useMediaStore.getState().setDeviceSelection({ micId: "mic-2", noiseSuppression: "standard" });
    await controller.retoggleMic();
    expect(h.retoggleMic).toHaveBeenCalledWith(h.localMic, h.publishes[0]?.sender, {
      deviceId: "mic-2",
      noiseSuppression: "standard",
    });
  });
});

describe("FR-20", () => {
  it("volume slider at 150% → setUserGain(1.5) and persists gain 1.5 under settings.volumes.v1", () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);

    controller.setUserVolume(REMOTE, 1.5);

    expect(h.graph.userGains.get(REMOTE)).toBe(1.5);
    expect(useSettingsStore.getState().volumes.users[REMOTE]).toBe(1.5);
    const raw = localStorage.getItem("settings.volumes.v1");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}") as { users: Record<string, number> };
    expect(parsed.users[REMOTE]).toBe(1.5);
  });

  it("Mute <name> adds userId to VolumesV1.mutedUsers and persists", () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);

    controller.setUserVolume(REMOTE, 1.5);
    controller.setUserMuted(REMOTE, true);

    expect(useSettingsStore.getState().volumes.mutedUsers).toContain(REMOTE);
    // mute is set-membership, not a gain of 0 — the stored slider value survives.
    expect(useSettingsStore.getState().volumes.users[REMOTE]).toBe(1.5);
    // but the effective graph gain applied while muted is 0.
    expect(h.graph.userGains.get(REMOTE)).toBe(0);
    const parsed = JSON.parse(localStorage.getItem("settings.volumes.v1") ?? "{}") as {
      mutedUsers: string[];
    };
    expect(parsed.mutedUsers).toContain(REMOTE);
  });
});

// TASK-1: the cross-platform audibility fixes — committed mic generations, exact re-pulls, and
// transport auto-recovery. Each defect here produced a silent asymmetric pair in a 3+ member call.
describe("TASK-1 audibility", () => {
  it("micSeq bump in voice.state → old pull closed, mic re-pulled (publisher rejoined)", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedHarnessVoice(h, "A", [{ userId: REMOTE, muted: false, deafened: false, micSeq: 1 }]);
    await controller.join("A");
    const pull = h.pulls[0];
    if (!pull) throw new Error("expected the voice pull session");
    expect(pull.added).toEqual([[{ trackName: `mic:${REMOTE}` }]]);

    // The remote re-registered their mic (new SFU session) — same roster, higher micSeq.
    h.ws.emit({
      t: "voice.state",
      voice: {
        members: [
          { userId: SELF, muted: false, deafened: false },
          { userId: REMOTE, muted: false, deafened: false, micSeq: 2 },
        ],
        sessionStartedAt: 1000,
      },
      at: 3000,
    });
    await flush();

    expect(pull.removed).toEqual([[`mic:${REMOTE}`]]);
    expect(pull.added).toEqual([
      [{ trackName: `mic:${REMOTE}` }],
      [{ trackName: `mic:${REMOTE}` }],
    ]);
    expect(h.graph.detached).toContain(REMOTE);
  });

  it("an unchanged micSeq does not re-pull (mute toggles must not churn the session)", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedHarnessVoice(h, "A", [{ userId: REMOTE, muted: false, deafened: false, micSeq: 1 }]);
    await controller.join("A");
    const pull = h.pulls[0];
    if (!pull) throw new Error("expected the voice pull session");

    h.ws.emit({
      t: "voice.state",
      voice: {
        members: [
          { userId: SELF, muted: false, deafened: false },
          { userId: REMOTE, muted: true, deafened: false, micSeq: 1 },
        ],
        sessionStartedAt: 1000,
      },
      at: 3000,
    });
    await flush();

    expect(pull.removed).toEqual([]);
    expect(pull.added).toHaveLength(1);
  });

  it("media reconnect → immediate teardown + rejoin preserving mute", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");
    controller.setMuted(true);
    expect(h.publishes).toHaveLength(1);

    h.pulls[0]?.recoveryNeeded?.();
    h.publishes[0]?.recoveryNeeded?.(); // both transports recover together → one rejoin
    await flush();

    expect(h.publishes).toHaveLength(2);
    expect(h.publishes[0]?.closed).toBe(true);
    expect(h.pulls).toHaveLength(2);
    expect(useMediaStore.getState().voiceStatus).toBe("joined");
    expect(useMediaStore.getState().muted).toBe(true);
    // the restored mute re-disabled the fresh mic track
    expect(h.publishes[1]?.enabled).toContainEqual([`mic:${SELF}`, false]);
  });
});

describe("FR-36 soundboard playback", () => {
  // A fake player that records each play — the controller wires this to the live `sound.played`
  // broadcast so a member hears a sound WITHOUT ever opening the soundboard panel (the bug fix).
  function harnessWithSoundboard() {
    const h = makeHarness();
    const plays: Array<{
      sound: { id: string; trimStartMs: number; trimEndMs: number; gain: number };
      mode: "shared" | "local-preview" | "editor-preview";
    }> = [];
    const stops: number[] = [];
    const stoppedSounds: string[] = [];
    const previewStops: Array<string | undefined> = [];
    const bytePlays: Array<{
      bytes: ArrayBuffer;
      sound: { id: string; trimStartMs: number; trimEndMs: number; gain: number };
      mode: "editor-preview";
    }> = [];
    const deps: VoiceDeps = {
      ...h.deps,
      createSoundboardPlayer: () => ({
        play: async (sound, mode = "shared") => {
          plays.push({ sound, mode });
        },
        playBytes: async (bytes, sound, mode, onStarted) => {
          bytePlays.push({ bytes, sound, mode });
          onStarted?.();
        },
        stopAll: () => stops.push(1),
        stop: (soundId) => stoppedSounds.push(soundId),
        stopPreview: (soundId) => previewStops.push(soundId),
      }),
    };
    return { h, plays, bytePlays, stops, stoppedSounds, previewStops, deps };
  }

  it("plays a `sound.played` broadcast while joined even if the panel never mounted", async () => {
    const { h, plays, deps } = harnessWithSoundboard();
    const controller = new VoiceController(deps);
    seedVoice("A", []);
    await controller.join("A");

    h.ws.emit({
      t: "sound.played",
      soundId: "s9",
      byUserId: REMOTE,
      at: 1,
      trimStartMs: 100,
      trimEndMs: 700,
      gain: 1.25,
    });
    await flush();

    expect(plays).toEqual([
      {
        sound: { id: "s9", trimStartMs: 100, trimEndMs: 700, gain: 1.25 },
        mode: "shared",
      },
    ]);
  });

  it("does not play when deafened", async () => {
    const { h, plays, deps } = harnessWithSoundboard();
    const controller = new VoiceController(deps);
    seedVoice("A", []);
    await controller.join("A");
    controller.setDeafened(true);

    h.ws.emit({
      t: "sound.played",
      soundId: "s9",
      byUserId: REMOTE,
      at: 1,
      trimStartMs: 0,
      trimEndMs: 500,
      gain: 1,
    });
    await flush();

    expect(plays).toEqual([]);
  });

  it("stops listening after leave (no play on a late broadcast)", async () => {
    const { h, plays, deps } = harnessWithSoundboard();
    const controller = new VoiceController(deps);
    seedVoice("A", []);
    await controller.join("A");
    await controller.leave();

    h.ws.emit({
      t: "sound.played",
      soundId: "s9",
      byUserId: REMOTE,
      at: 1,
      trimStartMs: 0,
      trimEndMs: 500,
      gain: 1,
    });
    await flush();

    expect(plays).toEqual([]);
  });

  it("overlaps different local previews and handles targeted preview/shared stops", async () => {
    const { h, plays, bytePlays, stoppedSounds, previewStops, deps } = harnessWithSoundboard();
    const controller = new VoiceController(deps);

    await controller.previewSoundboard("A", {
      id: "preview",
      trimStartMs: 50,
      trimEndMs: 450,
      gain: 0.8,
    });
    expect(plays).toEqual([
      {
        sound: { id: "preview", trimStartMs: 50, trimEndMs: 450, gain: 0.8 },
        mode: "local-preview",
      },
    ]);
    await controller.previewSoundboard("A", {
      id: "second-preview",
      trimStartMs: 0,
      trimEndMs: 300,
      gain: 1,
    });
    expect(plays).toHaveLength(2);
    expect(previewStops).toEqual([]);

    controller.stopSoundboardPreview("preview");
    expect(previewStops).toEqual(["preview"]);

    const bytes = new ArrayBuffer(8);
    const onStarted = vi.fn();
    await controller.previewSoundFile(
      "A",
      bytes,
      { trimStartMs: 100, trimEndMs: 600, gain: 1.2 },
      onStarted,
    );
    expect(bytePlays).toEqual([
      {
        bytes,
        sound: {
          id: "sound-editor-preview",
          trimStartMs: 100,
          trimEndMs: 600,
          gain: 1.2,
        },
        mode: "editor-preview",
      },
    ]);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(previewStops).toEqual(["preview", undefined]);

    seedVoice("A", []);
    await controller.join("A");
    h.ws.emit({
      t: "sound.stopped",
      soundId: "11111111-1111-4111-8111-111111111111",
      byUserId: REMOTE,
      at: 2,
    });
    expect(stoppedSounds).toContain("11111111-1111-4111-8111-111111111111");
  });
});
