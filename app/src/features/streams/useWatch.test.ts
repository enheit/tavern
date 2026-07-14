import type {
  ClientMessage,
  ScreenRid,
  ServerMessage,
  StreamInfo,
  WatchDelivery,
} from "@tavern/shared";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/lib/apiClient";
import { focusStore } from "@/lib/focusState";
import { m as messages } from "@/paraglide/messages.js";
import { resetWatchRegistry, useWatch, WatchController } from "@/features/streams/useWatch";
import type { WatchDeps } from "@/features/streams/useWatch";
import { useServersStore } from "@/stores/servers";
import { useSettingsStore } from "@/stores/settings";
import { fakeTrack } from "../../../test/fakes/media";

const registryDepsMock = vi.hoisted(() => ({
  createdPulls: 0,
  join: vi.fn(async () => undefined),
  send: vi.fn(),
  on: vi.fn(() => () => undefined),
  connect: vi.fn(async () => undefined),
  onTrack: vi.fn(() => () => undefined),
  addRemoteTracks: vi.fn(async () => undefined),
  removeRemoteTracks: vi.fn(async () => undefined),
  setLayer: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock("@/features/voice/voiceController", () => ({
  getVoiceController: () => ({
    join: registryDepsMock.join,
    streamAudioSink: () => null,
  }),
}));
vi.mock("@/lib/wsClient", () => ({
  connectRoom: () => ({ send: registryDepsMock.send, on: registryDepsMock.on }),
}));
vi.mock("@/media/rtc/pullSession", () => ({
  PullSession: class MockPullSession {
    constructor() {
      registryDepsMock.createdPulls += 1;
    }
    connect(): Promise<void> {
      return registryDepsMock.connect();
    }
    onTrack(): () => void {
      return registryDepsMock.onTrack();
    }
    addRemoteTracks(): Promise<void> {
      return registryDepsMock.addRemoteTracks();
    }
    removeRemoteTracks(): Promise<void> {
      return registryDepsMock.removeRemoteTracks();
    }
    setLayer(): Promise<void> {
      return registryDepsMock.setLayer();
    }
    close(): Promise<void> {
      return registryDepsMock.close();
    }
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// jsdom has no MediaStream; the controller wraps each pulled track in one (video → tile,
// audio → graph). A minimal double is enough (PLAN §9.1 allows test-double casts).
class FakeMediaStream {
  readonly tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks;
  }
}
vi.stubGlobal("MediaStream", FakeMediaStream);

const UID = "11111111-1111-4111-8111-111111111111";

function makeStream(over: Partial<StreamInfo> = {}): StreamInfo {
  return {
    trackName: `screen:${UID}:1`,
    kind: "screen",
    userId: UID,
    hasAudio: false,
    preset: "1080p30",
    ...over,
  };
}

class FakePull {
  connected = false;
  closed = false;
  rejectWith: Error | null = null;
  readonly added: Array<Array<{ trackName: string; preferredRid?: ScreenRid }>> = [];
  readonly removed: string[][] = [];
  readonly layers: Array<{ trackName: string; rid: ScreenRid }> = [];
  private trackCb: ((tn: string, track: MediaStreamTrack, stream: MediaStream) => void) | null =
    null;
  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }
  onTrack(cb: (tn: string, track: MediaStreamTrack, stream: MediaStream) => void): () => void {
    this.trackCb = cb;
    return () => {
      this.trackCb = null;
    };
  }
  addRemoteTracks(tracks: Array<{ trackName: string; preferredRid?: ScreenRid }>): Promise<void> {
    this.added.push(tracks);
    return this.rejectWith ? Promise.reject(this.rejectWith) : Promise.resolve();
  }
  removeRemoteTracks(trackNames: string[]): Promise<void> {
    this.removed.push(trackNames);
    return Promise.resolve();
  }
  setLayer(trackName: string, rid: ScreenRid): Promise<void> {
    this.layers.push({ trackName, rid });
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  emit(tn: string, track: MediaStreamTrack): void {
    this.trackCb?.(tn, track, new MediaStream([track]));
  }
}

class FakeWs {
  readonly sent: ClientMessage[] = [];
  private readonly listeners = new Map<string, Set<(m: ServerMessage) => void>>();
  send(msg: ClientMessage): void {
    this.sent.push(msg);
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

// A full room resnapshot frame (§6.2). Only its `t` matters to the controller; the FakeWs relays
// it unvalidated, so the remaining fields just satisfy the ServerMessage type.
function helloOk(): Extract<ServerMessage, { t: "hello.ok" }> {
  return {
    t: "hello.ok",
    self: { userId: UID, username: "u", displayName: "U", color: "#abcdef" },
    serverMeta: { id: "srv", nickname: "n", adminUserId: UID },
    members: [],
    voice: { members: [], sessionStartedAt: null },
    streams: [makeStream()],
    recording: { active: false },
    status: "",
    lastMessageId: null,
    lastReadMessageId: 0,
    firstUnreadMessageId: null,
    unreadCount: 0,
    costStatus: { usedGB: 0, capGB: 100, blocked: false },
    polls: [],
    points: {
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
    },
  };
}

function makeSink(): {
  attachStreamAudio: ReturnType<typeof vi.fn<(streamKey: string, stream: MediaStream) => void>>;
  detachStreamAudio: ReturnType<typeof vi.fn<(streamKey: string) => void>>;
  setStreamVolume: ReturnType<typeof vi.fn<(streamKey: string, level: number) => void>>;
} {
  return {
    attachStreamAudio: vi.fn<(streamKey: string, stream: MediaStream) => void>(),
    detachStreamAudio: vi.fn<(streamKey: string) => void>(),
    setStreamVolume: vi.fn<(streamKey: string, level: number) => void>(),
  };
}

function harness(over: Partial<WatchDeps> = {}): {
  pull: FakePull;
  ws: FakeWs;
  sink: ReturnType<typeof makeSink>;
  createPull: ReturnType<typeof vi.fn>;
  joinVoice: ReturnType<typeof vi.fn>;
  setDelivery: ReturnType<typeof vi.fn>;
  deps: WatchDeps;
} {
  const pull = new FakePull();
  const ws = new FakeWs();
  const sink = makeSink();
  const createPull = vi.fn(() => pull);
  const joinVoice = vi.fn(async () => undefined);
  const setDelivery = vi.fn(
    async (_serverId: string, _trackName: string, _delivery: WatchDelivery) => undefined,
  );
  const deps: WatchDeps = {
    createPull,
    wsFor: () => ws,
    sink: () => sink,
    activeServerId: () => "srv",
    joinVoice,
    setDelivery,
    ...over,
  };
  return { pull, ws, sink, createPull, joinVoice, setDelivery, deps };
}

async function flush(): Promise<void> {
  await Array.from({ length: 25 }).reduce<Promise<void>>(
    (p) => p.then(() => undefined),
    Promise.resolve(),
  );
}

beforeEach(() => {
  // The per-stream WatchController registry (used by the useWatch hook) is module-level — clear it so a
  // controller from one test never leaks into the next.
  resetWatchRegistry();
  vi.clearAllMocks();
  registryDepsMock.createdPulls = 0;
  focusStore.setState({ focused: true, visible: true });
  // Reset persisted volumes so the FR-31 hydration tests don't bleed a stream gain into other cases.
  useSettingsStore.setState({
    volumes: { v: 1, users: {}, streams: {}, soundboard: 1, mutedUsers: [] },
  });
});

describe("FR-30 opt-in watching", () => {
  it("no PullSession exists before watch()", () => {
    const h = harness();
    const controller = new WatchController(makeStream(), h.deps);
    expect(h.createPull).not.toHaveBeenCalled();
    expect(controller.state).toBe("idle");
    expect(controller.mediaStream).toBeNull();
  });

  it("watch() joins voice before sending watch.start, then creates one PullSession pulling preferredRid h", async () => {
    const stream = makeStream();
    const h = harness();
    const controller = new WatchController(stream, h.deps);

    await controller.watch();
    await flush();

    expect(h.joinVoice).toHaveBeenCalledWith("srv");
    expect(h.ws.sent[0]).toEqual({ t: "watch.start", trackName: stream.trackName });
    expect(h.createPull).toHaveBeenCalledTimes(1);
    expect(h.pull.added[0]).toEqual([{ trackName: stream.trackName, preferredRid: "h" }]);
    expect(controller.state).toBe("watching");

    // A video frame arriving populates mediaStream for the tile's <video>.
    const video = fakeTrack("video");
    h.pull.emit(stream.trackName, video);
    expect(controller.mediaStream).toBeInstanceOf(FakeMediaStream);
  });

  it("does not request a watch grant when joining voice fails", async () => {
    const h = harness({ joinVoice: vi.fn(() => Promise.reject(new Error("microphone denied"))) });
    const controller = new WatchController(makeStream(), h.deps);

    await controller.watch();

    expect(controller.state).toBe("idle");
    expect(h.ws.sent).toEqual([]);
    expect(h.createPull).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(messages.voice_join_failed());
  });

  it("hasAudio pulls audio track and attaches to graph", async () => {
    const stream = makeStream({ hasAudio: true });
    const h = harness();
    const controller = new WatchController(stream, h.deps);

    controller.watch();
    await flush();

    expect(h.pull.added[0]).toEqual([
      { trackName: `screen:${UID}:1`, preferredRid: "h" },
      { trackName: `screenAudio:${UID}:1` },
    ]);

    const audio = fakeTrack("audio");
    h.pull.emit(`screenAudio:${UID}:1`, audio);
    expect(h.sink.attachStreamAudio).toHaveBeenCalledWith(
      `${UID}:screen`,
      expect.any(FakeMediaStream),
    );
    // The video path never routes to the audio sink.
    h.pull.emit(stream.trackName, fakeTrack("video"));
    expect(h.sink.attachStreamAudio).toHaveBeenCalledTimes(1);
  });

  it("FR-31 re-applies the viewer's persisted per-stream volume on attach", async () => {
    const key = `${UID}:screen`;
    useSettingsStore.setState({
      volumes: { v: 1, users: {}, streams: { [key]: 0.5 }, soundboard: 1, mutedUsers: [] },
    });
    const h = harness();
    const controller = new WatchController(makeStream({ hasAudio: true }), h.deps);
    controller.watch();
    await flush();

    h.pull.emit(`screenAudio:${UID}:1`, fakeTrack("audio"));
    expect(h.sink.setStreamVolume).toHaveBeenCalledWith(key, 0.5);
  });

  it("FR-31 leaves the graph at unity when no persisted volume exists", async () => {
    useSettingsStore.setState({
      volumes: { v: 1, users: {}, streams: {}, soundboard: 1, mutedUsers: [] },
    });
    const h = harness();
    const controller = new WatchController(makeStream({ hasAudio: true }), h.deps);
    controller.watch();
    await flush();

    h.pull.emit(`screenAudio:${UID}:1`, fakeTrack("audio"));
    expect(h.sink.setStreamVolume).not.toHaveBeenCalled();
  });

  it("unwatch() closes session and sends watch.stop", async () => {
    const stream = makeStream({ hasAudio: true });
    const h = harness();
    const controller = new WatchController(stream, h.deps);
    controller.watch();
    await flush();

    controller.unwatch();
    await flush();

    expect(h.pull.closed).toBe(true);
    expect(h.sink.detachStreamAudio).toHaveBeenCalledWith(`${UID}:screen`);
    expect(h.ws.sent.some((m) => m.t === "watch.stop" && m.trackName === stream.trackName)).toBe(
      true,
    );
    expect(controller.state).toBe("idle");
    expect(controller.mediaStream).toBeNull();
  });

  it("stream.removed while watching auto-unwatches", async () => {
    const stream = makeStream();
    const h = harness();
    const controller = new WatchController(stream, h.deps);
    controller.watch();
    await flush();

    h.ws.emit({ t: "stream.removed", trackName: stream.trackName, at: 1 });
    await flush();

    expect(h.pull.closed).toBe(true);
    expect(controller.state).toBe("idle");
    // A stream.removed for a DIFFERENT track leaves an idle controller untouched.
    h.ws.emit({ t: "stream.removed", trackName: "screen:other:1", at: 2 });
    expect(controller.state).toBe("idle");
  });

  it("a hello.ok resnapshot resets a live watch to idle (no zombie on transient reconnect)", async () => {
    const stream = makeStream({ hasAudio: true });
    const h = harness();
    const controller = new WatchController(stream, h.deps);
    controller.watch();
    await flush();
    expect(controller.state).toBe("watching");

    // A transient reconnect replays the full snapshot; the server already swept this viewer's
    // grant/session/meter on the preceding disconnect, so the live pull is orphaned. The controller
    // must reset to idle (Placeholder + Watch) instead of sitting stuck in `watching`.
    h.ws.emit(helloOk());
    await flush();

    expect(controller.state).toBe("idle");
    expect(controller.mediaStream).toBeNull();
    expect(h.pull.closed).toBe(true);
    expect(h.sink.detachStreamAudio).toHaveBeenCalledWith(`${UID}:screen`);
    expect(h.ws.sent.some((mm) => mm.t === "watch.stop" && mm.trackName === stream.trackName)).toBe(
      true,
    );
  });

  it("grant error surfaces typed store status and returns to idle", async () => {
    const stream = makeStream();
    const failing = new FakePull();
    failing.rejectWith = new ApiError("pull_denied", 403);
    const h = harness({ createPull: vi.fn(() => failing) });
    const controller = new WatchController(stream, h.deps);

    controller.watch();
    await flush();

    expect(controller.state).toBe("idle");
    expect(failing.closed).toBe(true);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("setLayer forwards the rid to the pull (FR-33)", async () => {
    const stream = makeStream();
    const h = harness();
    const controller = new WatchController(stream, h.deps);
    controller.watch();
    await flush();

    controller.setLayer("h");
    expect(h.pull.layers).toEqual([{ trackName: stream.trackName, rid: "h" }]);
  });

  it("keeps an audio watch alive while hidden and restores video on the same PullSession", async () => {
    const stream = makeStream({ hasAudio: true });
    const h = harness();
    const controller = new WatchController(stream, h.deps);
    await controller.watch();
    await flush();
    h.pull.emit(stream.trackName, fakeTrack("video"));

    controller.setDocumentVisible(false);
    await flush();

    expect(controller.state).toBe("watching");
    expect(controller.delivery).toBe("audio");
    expect(controller.mediaStream).toBeNull();
    expect(h.pull.removed).toEqual([[stream.trackName]]);
    expect(h.setDelivery).toHaveBeenLastCalledWith("srv", stream.trackName, "audio");
    expect(h.createPull).toHaveBeenCalledTimes(1);
    expect(h.ws.sent.filter((message) => message.t === "watch.stop")).toEqual([]);

    controller.setDocumentVisible(true);
    await flush();

    expect(controller.state).toBe("watching");
    expect(controller.delivery).toBe("high");
    expect(h.pull.added[1]).toEqual([{ trackName: stream.trackName, preferredRid: "h" }]);
    expect(h.setDelivery).toHaveBeenLastCalledWith("srv", stream.trackName, "video");
    expect(h.createPull).toHaveBeenCalledTimes(1);
    expect(h.ws.sent.filter((message) => message.t === "watch.start")).toHaveLength(1);
  });

  it("uses low video for a hidden video-only watch without ending it", async () => {
    const stream = makeStream({ hasAudio: false });
    const h = harness();
    const controller = new WatchController(stream, h.deps);
    await controller.watch();
    await flush();

    controller.setDocumentVisible(false);
    await flush();
    expect(controller.delivery).toBe("low");
    expect(h.pull.layers).toEqual([{ trackName: stream.trackName, rid: "l" }]);
    expect(h.pull.removed).toEqual([]);
    expect(h.setDelivery).not.toHaveBeenCalled();

    controller.setDocumentVisible(true);
    await flush();
    expect(controller.delivery).toBe("high");
    expect(h.pull.layers).toEqual([
      { trackName: stream.trackName, rid: "l" },
      { trackName: stream.trackName, rid: "h" },
    ]);
    expect(controller.state).toBe("watching");
    expect(h.createPull).toHaveBeenCalledTimes(1);
  });

  it("applies theater saver delivery without sending watch.stop", async () => {
    const stream = makeStream({ hasAudio: true });
    const h = harness();
    const controller = new WatchController(stream, h.deps);
    await controller.watch();
    await flush();

    controller.setTheaterVisible(false);
    await flush();
    expect(controller.delivery).toBe("audio");
    expect(h.ws.sent.filter((message) => message.t === "watch.stop")).toEqual([]);

    controller.setTheaterVisible(true);
    await flush();
    expect(controller.delivery).toBe("high");
    expect(h.createPull).toHaveBeenCalledTimes(1);
  });

  // The React hook wraps the controller with the real default deps; with no active server watch()
  // is a no-op (G1 — nothing pulled) and the tile stays idle.
  it("useWatch hook starts idle and no-ops watch without an active server", () => {
    useServersStore.setState({ activeServerId: null });
    const { result } = renderHook(() => useWatch(makeStream()));
    expect(result.current.state).toBe("idle");
    expect(result.current.mediaStream).toBeNull();
    act(() => {
      result.current.watch();
    });
    expect(result.current.state).toBe("idle");
  });

  it("keeps one live controller across a tile unmount/remount", async () => {
    useServersStore.setState({ activeServerId: "srv" });
    const stream = makeStream();
    const first = renderHook(() => useWatch(stream));

    await act(async () => {
      first.result.current.watch();
      await flush();
    });
    expect(first.result.current.state).toBe("watching");
    expect(registryDepsMock.createdPulls).toBe(1);
    expect(registryDepsMock.send).toHaveBeenCalledWith({
      t: "watch.start",
      trackName: stream.trackName,
    });

    first.unmount();
    expect(registryDepsMock.close).not.toHaveBeenCalled();
    expect(
      registryDepsMock.send.mock.calls.some(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "t" in message &&
          message.t === "watch.stop",
      ),
    ).toBe(false);

    const remounted = renderHook(() => useWatch(stream));
    expect(remounted.result.current.state).toBe("watching");
    expect(registryDepsMock.createdPulls).toBe(1);
    remounted.unmount();
  });
});
