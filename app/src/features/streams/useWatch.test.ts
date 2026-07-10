import type { ClientMessage, ServerMessage, StreamInfo } from "@tavern/shared";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/lib/apiClient";
import { resetWatchRegistry, useWatch, WatchController } from "@/features/streams/useWatch";
import type { WatchDeps } from "@/features/streams/useWatch";
import { useServersStore } from "@/stores/servers";
import { fakeTrack } from "../../../test/fakes/media";

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
  readonly added: Array<Array<{ trackName: string; preferredRid?: "h" | "l" }>> = [];
  readonly layers: Array<{ trackName: string; rid: "h" | "l" }> = [];
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
  addRemoteTracks(tracks: Array<{ trackName: string; preferredRid?: "h" | "l" }>): Promise<void> {
    this.added.push(tracks);
    return this.rejectWith ? Promise.reject(this.rejectWith) : Promise.resolve();
  }
  setLayer(trackName: string, rid: "h" | "l"): Promise<void> {
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

function makeSink(): {
  attachStreamAudio: ReturnType<typeof vi.fn<(streamKey: string, stream: MediaStream) => void>>;
  detachStreamAudio: ReturnType<typeof vi.fn<(streamKey: string) => void>>;
  setStreamGain: ReturnType<typeof vi.fn<(streamKey: string, gain: number) => void>>;
} {
  return {
    attachStreamAudio: vi.fn<(streamKey: string, stream: MediaStream) => void>(),
    detachStreamAudio: vi.fn<(streamKey: string) => void>(),
    setStreamGain: vi.fn<(streamKey: string, gain: number) => void>(),
  };
}

function harness(over: Partial<WatchDeps> = {}): {
  pull: FakePull;
  ws: FakeWs;
  sink: ReturnType<typeof makeSink>;
  createPull: ReturnType<typeof vi.fn>;
  deps: WatchDeps;
} {
  const pull = new FakePull();
  const ws = new FakeWs();
  const sink = makeSink();
  const createPull = vi.fn(() => pull);
  const deps: WatchDeps = {
    createPull,
    wsFor: () => ws,
    sink: () => sink,
    activeServerId: () => "srv",
    ...over,
  };
  return { pull, ws, sink, createPull, deps };
}

async function flush(): Promise<void> {
  await Array.from({ length: 25 }).reduce<Promise<void>>(
    (p) => p.then(() => undefined),
    Promise.resolve(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The per-stream WatchController registry (used by the useWatch hook) is module-level — clear it so a
  // controller from one test never leaks into the next (the deferred teardown is timer-based).
  resetWatchRegistry();
});

describe("FR-30 opt-in watching", () => {
  it("no PullSession exists before watch()", () => {
    const h = harness();
    const controller = new WatchController(makeStream(), h.deps);
    expect(h.createPull).not.toHaveBeenCalled();
    expect(controller.state).toBe("idle");
    expect(controller.mediaStream).toBeNull();
  });

  it("watch() sends watch.start then creates one PullSession pulling preferredRid l", async () => {
    const stream = makeStream();
    const h = harness();
    const controller = new WatchController(stream, h.deps);

    controller.watch();
    await flush();

    expect(h.ws.sent[0]).toEqual({ t: "watch.start", trackName: stream.trackName });
    expect(h.createPull).toHaveBeenCalledTimes(1);
    expect(h.pull.added[0]).toEqual([{ trackName: stream.trackName, preferredRid: "l" }]);
    expect(controller.state).toBe("watching");

    // A video frame arriving populates mediaStream for the tile's <video>.
    const video = fakeTrack("video");
    h.pull.emit(stream.trackName, video);
    expect(controller.mediaStream).toBeInstanceOf(FakeMediaStream);
  });

  it("hasAudio pulls audio track and attaches to graph", async () => {
    const stream = makeStream({ hasAudio: true });
    const h = harness();
    const controller = new WatchController(stream, h.deps);

    controller.watch();
    await flush();

    expect(h.pull.added[0]).toEqual([
      { trackName: `screen:${UID}:1`, preferredRid: "l" },
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
});
