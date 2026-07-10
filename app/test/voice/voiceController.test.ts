import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage, UserProfile, VoiceMember } from "@tavern/shared";
import { VoiceController, VoiceElsewhereError } from "@/features/voice/voiceController";
import type { VoiceDeps } from "@/features/voice/voiceController";
import { useMediaStore } from "@/stores/media";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { fakeTrack } from "../fakes/media";

const SELF = "11111111-1111-1111-1111-111111111111";
const REMOTE = "22222222-2222-2222-2222-222222222222";

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
  // Screen share (S8.1) publishes on this shared session; unused by the voice-only tests here.
  async publishStream(): Promise<{ videoTrackName: string; audioTrackName?: string }> {
    this.log.push("publish.publishStream");
    return { videoTrackName: `screen:${this.userId}:1` };
  }
  async unpublish(names: string[]): Promise<void> {
    this.log.push(`publish.unpublish:${names.join(",")}`);
  }
  micSender(): RTCRtpSender | null {
    return this.sender;
  }
  setTrackEnabled(name: string, enabled: boolean): void {
    this.log.push(`publish.setEnabled:${enabled}`);
    this.enabled.push([name, enabled]);
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
  readonly added: Array<Array<{ trackName: string; preferredRid?: "h" | "l" }>> = [];
  readonly removed: string[][] = [];
  constructor(log: string[]) {
    this.log = log;
  }
  async connect(): Promise<void> {
    this.log.push("pull.connect");
    this.connected = true;
  }
  onTrack(): () => void {
    return () => undefined;
  }
  async addRemoteTracks(
    tracks: Array<{ trackName: string; preferredRid?: "h" | "l" }>,
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
  readonly streamGains = new Map<string, number>();
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
  setStreamGain(streamKey: string, gain: number): void {
    this.streamGains.set(streamKey, gain);
  }
  setDeafened(deafened: boolean): void {
    this.log.push(`graph.setDeafened:${deafened}`);
    this.deafened = deafened;
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
  private readonly listeners = new Map<string, Set<(m: ServerMessage) => void>>();
  constructor(log: string[]) {
    this.log = log;
  }
  send(msg: ClientMessage): void {
    this.sent.push(msg);
    this.log.push(`ws.${msg.t}`);
    if (msg.t === "voice.join") {
      const members: VoiceMember[] = [
        { userId: SELF, muted: false, deafened: false },
        ...this.ackMembers,
      ];
      this.emit({ t: "voice.state", voice: { members, sessionStartedAt: 1000 }, at: 2000 });
    }
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
  const watchSpeaking = vi.fn(() => () => undefined);
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
  return { log, publishes, pulls, graph, ws, getMic, retoggleMic, watchSpeaking, deps, localMic };
}

function seedVoice(serverId: string, members: VoiceMember[]): void {
  const self: UserProfile = {
    userId: SELF,
    username: "self",
    displayName: "Self",
    color: "#123456",
  };
  roomStore(serverId)
    .getState()
    .apply({
      t: "hello.ok",
      self,
      serverMeta: { id: serverId, nickname: "cave", adminUserId: SELF },
      members: [],
      voice: { members, sessionStartedAt: members.length > 0 ? 500 : null },
      streams: [],
      recording: { active: false },
      lastMessageId: null,
      costStatus: { usedGB: 0, capGB: 900, blocked: false },
    });
}

async function flush(): Promise<void> {
  // Drain ~25 microtask turns (a chained then-ladder, no await-in-loop) so the fire-and-forget
  // reconnect rejoin settles before assertions.
  await Array.from({ length: 25 }).reduce<Promise<void>>(
    (p) => p.then(() => undefined),
    Promise.resolve(),
  );
}

beforeEach(() => {
  localStorage.clear();
  resetRoomStores();
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
    deviceSelection: { noiseSuppression: true },
  });
  useSettingsStore.setState({
    volumes: { v: 1, users: {}, streams: {}, soundboard: 1, mutedUsers: [] },
  });
});

describe("FR-18 join/leave", () => {
  it("join sends voice.join before any rtc call (order)", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);

    await controller.join("A");

    expect(h.log).toEqual([
      "ws.voice.join",
      "graph.init",
      "graph.resume",
      "getMic",
      "publish.connect",
      "publish.publishMic",
      "graph.attachLocalMic",
      "pull.connect",
    ]);
    expect(useMediaStore.getState().voiceStatus).toBe("joined");
    expect(useMediaStore.getState().inVoiceServerId).toBe("A");
  });

  it("join wires mic publish then pulls every existing remote mic", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", [{ userId: REMOTE, muted: false, deafened: false }]);

    await controller.join("A");

    expect(h.log.indexOf("publish.publishMic")).toBeLessThan(h.log.indexOf("pull.addRemoteTracks"));
    expect(h.pulls[0]?.added).toEqual([[{ trackName: `mic:${REMOTE}` }]]);
  });

  it("streamAudioSink is null until joined, the graph while joined, null after leave (S8.2)", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);

    expect(controller.streamAudioSink()).toBeNull();
    await controller.join("A");
    expect(controller.streamAudioSink()).toBe(h.graph);
    // The sink routes a watched-stream gain to the SAME graph (FR-31).
    controller.streamAudioSink()?.setStreamGain("uuu:screen", 2);
    expect(h.graph.streamGains.get("uuu:screen")).toBe(2);

    await controller.leave();
    expect(controller.streamAudioSink()).toBeNull();
  });

  it("leave tears down sessions, graph detaches, sends voice.leave", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", [{ userId: REMOTE, muted: false, deafened: false }]);
    await controller.join("A");

    await controller.leave();

    expect(h.pulls[0]?.closed).toBe(true);
    expect(h.publishes[0]?.closed).toBe(true);
    expect(h.graph.closed).toBe(true);
    expect(h.graph.detached).toContain(REMOTE);
    expect(h.ws.sent.some((m) => m.t === "voice.leave")).toBe(true);
    expect(useMediaStore.getState().voiceStatus).toBe("idle");
    expect(useMediaStore.getState().inVoiceServerId).toBeNull();
  });

  it("ws reconnect while joined → teardown + rejoin", async () => {
    const h = makeHarness();
    const controller = new VoiceController(h.deps);
    seedVoice("A", []);
    await controller.join("A");

    h.ws.emit({
      t: "hello.ok",
      self: { userId: SELF, username: "self", displayName: "Self", color: "#123456" },
      serverMeta: { id: "A", nickname: "cave", adminUserId: SELF },
      members: [],
      voice: { members: [], sessionStartedAt: null },
      streams: [],
      recording: { active: false },
      lastMessageId: null,
      costStatus: { usedGB: 0, capGB: 900, blocked: false },
    });
    await flush();

    expect(h.publishes).toHaveLength(2);
    expect(h.publishes[0]?.closed).toBe(true);
    expect(h.pulls).toHaveLength(2);
    expect(h.ws.sent.filter((m) => m.t === "voice.join")).toHaveLength(2);
    expect(useMediaStore.getState().voiceStatus).toBe("joined");
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
    useMediaStore.getState().setDeviceSelection({ noiseSuppression: false });

    await controller.retoggleMic();

    expect(h.retoggleMic).toHaveBeenCalledWith(h.localMic, h.publishes[0]?.sender, {
      noiseSuppression: false,
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

    useMediaStore.getState().setDeviceSelection({ micId: "mic-2", noiseSuppression: true });
    await controller.retoggleMic();
    expect(h.retoggleMic).toHaveBeenCalledWith(h.localMic, h.publishes[0]?.sender, {
      deviceId: "mic-2",
      noiseSuppression: true,
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
