import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@tavern/shared";
import { createRecordingUploadApi, R2MultipartSink, VoiceRecorder } from "@/media/recorder";
import type { RecorderChunkSink, RecorderState } from "@/media/recorder";
import { ApiError } from "@/lib/apiClient";
import type { AudioGraph } from "@/media/audioGraph";
import { fakeTrack } from "../fakes/media";

const PART = LIMITS.recordingPartBytes;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function noop(): void {
  // placeholder resolver until the gated onPart supplies the real one
}

// A fake MediaRecorder the tests drive by hand: `emit(bytes)` fires a `dataavailable`, `stop()` fires
// `stop` (a real recorder emits a trailing dataavailable then stop — the tests emit that data first).
const recorders: FakeMediaRecorder[] = [];

function fakeBlob(bytes: Uint8Array): Blob {
  return { arrayBuffer: async () => bytes.slice().buffer } as unknown as Blob;
}

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }
  state = "inactive";
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();
  constructor(
    readonly stream: unknown,
    readonly options: unknown,
  ) {
    recorders.push(this);
  }
  addEventListener(type: string, cb: (e: unknown) => void, opts?: { once?: boolean }): void {
    const set = this.listeners.get(type) ?? new Set<(e: unknown) => void>();
    const wrapped = (e: unknown): void => {
      if (opts?.once === true) set.delete(wrapped);
      cb(e);
    };
    set.add(wrapped);
    this.listeners.set(type, set);
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    this.dispatch("stop", {});
  }
  emit(bytes: Uint8Array): void {
    this.dispatch("dataavailable", { data: fakeBlob(bytes) });
  }
  private dispatch(type: string, event: unknown): void {
    for (const cb of Array.from(this.listeners.get(type) ?? [])) cb(event);
  }
}

function fakeGraph(): AudioGraph {
  return {
    mixForRecording: () => ({}) as MediaStream,
    releaseRecordingMix: () => undefined,
  } as unknown as AudioGraph;
}

// A spy-backed RecordingUploadApi (inferred return keeps the `.mock` accessors typed per method). Each
// method carries its full param list so mock.calls entries stay indexable.
function fakeApi() {
  return {
    open: vi.fn(async () => ({ recordingId: "rec-1", uploadId: "up-1" })),
    uploadPart: vi.fn(async (_id: string, _n: number, _bytes: Uint8Array, _final: boolean) => ({
      etag: "etag",
    })),
    complete: vi.fn(
      async (_id: string, _parts: { partNumber: number; etag: string }[], _ms: number) => undefined,
    ),
    abort: vi.fn(async (_id: string) => undefined),
  };
}

beforeEach(() => {
  recorders.length = 0;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FR-25 recorder part slicing", () => {
  it("slices exactly recordingPartBytes at the boundary (queued 5MiB+1 → one full part, 1 byte remains)", async () => {
    const onPart = vi.fn<(n: number, b: Uint8Array, f: boolean) => Promise<void>>(
      async () => undefined,
    );
    const sink: RecorderChunkSink = { onPart };
    const recorder = new VoiceRecorder({ graph: fakeGraph() });
    recorder.start(fakeTrack("audio"), sink);
    const fr = must(recorders.at(-1), "recorder created");

    fr.emit(new Uint8Array(PART + 1));
    await vi.waitFor(() => expect(onPart).toHaveBeenCalledTimes(1));
    const first = must(onPart.mock.calls[0], "first onPart");
    expect(first[0]).toBe(1);
    expect(first[1].length).toBe(PART);
    expect(first[2]).toBe(false);

    const { durationMs } = await recorder.stop();
    expect(onPart).toHaveBeenCalledTimes(2);
    const final = must(onPart.mock.calls[1], "final onPart");
    expect(final[0]).toBe(2);
    expect(final[1].length).toBe(1); // the 1 byte that did not fill a part
    expect(final[2]).toBe(true);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(recorder.active).toBe(false);
  });

  it("accumulates multiple timeslices into sequential onPart calls, one in-flight at a time", async () => {
    let releaseFirst: () => void = noop;
    const started: number[] = [];
    const onPart = vi.fn<(n: number, b: Uint8Array, f: boolean) => Promise<void>>(async (n) => {
      started.push(n);
      if (n === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });
    const recorder = new VoiceRecorder({ graph: fakeGraph() });
    recorder.start(fakeTrack("audio"), { onPart });
    const fr = must(recorders.at(-1), "recorder created");

    // Two full-part timeslices → two parts, but part 1 blocks, so part 2 must not start yet.
    fr.emit(new Uint8Array(PART));
    fr.emit(new Uint8Array(PART));
    await vi.waitFor(() => expect(started).toEqual([1]));
    expect(onPart).toHaveBeenCalledTimes(1); // one in-flight

    releaseFirst(); // reassigned to the pending resolver once part 1 began awaiting
    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    await recorder.stop();
  });

  it("stop flushes a smaller final part (isFinal); sink.finish(durationMs) calls api.complete", async () => {
    const api = fakeApi();
    const states: RecorderState[] = [];
    const sink = new R2MultipartSink(api, (s) => states.push(s));
    const recorder = new VoiceRecorder({ graph: fakeGraph() });
    recorder.start(fakeTrack("audio"), sink);
    const fr = must(recorders.at(-1), "recorder created");

    fr.emit(new Uint8Array(PART + 100)); // one full part now, 100-byte tail on stop
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledTimes(1));

    const { durationMs } = await recorder.stop();
    expect(api.uploadPart).toHaveBeenCalledTimes(2);
    const finalCall = must(api.uploadPart.mock.calls[1], "final uploadPart");
    expect(finalCall[3]).toBe(true); // isFinal
    expect(sink.recordingId).toBe("rec-1");

    await sink.finish(durationMs);
    expect(api.complete).toHaveBeenCalledTimes(1);
    const completeCall = must(api.complete.mock.calls[0], "complete call");
    expect(completeCall[2]).toBe(durationMs);
    expect(completeCall[1]).toHaveLength(2); // both parts collected
    expect(states).toContain("finishing");
    expect(states).toContain("idle");
  });

  it("R2MultipartSink part failure retries 3x then aborts and enters error state", async () => {
    vi.useFakeTimers();
    const uploadPart = vi.fn(
      async (
        _id: string,
        _n: number,
        _bytes: Uint8Array,
        _final: boolean,
      ): Promise<{ etag: string }> => {
        throw new Error("network");
      },
    );
    const api = {
      open: vi.fn(async () => ({ recordingId: "rec-1", uploadId: "up-1" })),
      uploadPart,
      complete: vi.fn(async (_id: string) => undefined),
      abort: vi.fn(async (_id: string) => undefined),
    };
    const states: RecorderState[] = [];
    const sink = new R2MultipartSink(api, (s) => states.push(s));

    const pending = sink.onPart(1, new Uint8Array(10), false);
    await vi.runAllTimersAsync(); // drain the 1s/2s/4s backoff waits
    await pending;

    expect(api.uploadPart).toHaveBeenCalledTimes(4); // initial + ×3 retries
    expect(api.abort).toHaveBeenCalledTimes(1);
    expect(states).toContain("error");
    vi.useRealTimers();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FR-25 recording upload transport", () => {
  const serverId = "srv-1";
  const RID = crypto.randomUUID();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("open → uploadPart → complete → abort hit the pinned §6.1 endpoints", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith(`/api/servers/${serverId}/recordings`)) {
        return jsonResponse({ recordingId: RID, uploadId: "up-9" });
      }
      if (url.includes("/part?")) return jsonResponse({ etag: "etag-1" });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = createRecordingUploadApi(serverId);
    const opened = await api.open();
    expect(opened).toEqual({ recordingId: RID, uploadId: "up-9" });

    const part = await api.uploadPart(RID, 1, new Uint8Array([1, 2, 3]), true);
    expect(part.etag).toBe("etag-1");
    const partReq = must(
      seen.find((r) => r.url.includes("/part?")),
      "part request",
    );
    expect(partReq.method).toBe("PUT");
    expect(partReq.url).toContain("uploadId=up-9");
    expect(partReq.url).toContain("final=1");

    await api.complete(RID, [{ partNumber: 1, etag: "etag-1" }], 5000);
    await api.abort(RID);
    expect(seen.some((r) => r.url.endsWith(`/${RID}/complete`) && r.method === "POST")).toBe(true);
    expect(seen.some((r) => r.url.endsWith(`/${RID}/abort`) && r.method === "POST")).toBe(true);
  });

  it("uploadPart before open throws; a non-2xx part response throws ApiError", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith(`/api/servers/${serverId}/recordings`)) {
        return jsonResponse({ recordingId: RID, uploadId: "up-9" });
      }
      return jsonResponse({ error: "bad_part_size" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = createRecordingUploadApi(serverId);
    await expect(api.uploadPart(RID, 1, new Uint8Array([1]), false)).rejects.toThrow();

    await api.open();
    await expect(api.uploadPart(RID, 1, new Uint8Array([1]), false)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
