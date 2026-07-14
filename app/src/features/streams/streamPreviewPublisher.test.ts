import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@tavern/shared";
import { StreamPreviewPublisher, type StreamPreviewPublisherDeps } from "./streamPreviewPublisher";

function track(id: string): MediaStreamTrack {
  return { id, kind: "video" } as MediaStreamTrack;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === undefined) throw new Error("deferred promise was not initialized");
      resolvePromise();
    },
  };
}

function harness(upload: StreamPreviewPublisherDeps["upload"] = vi.fn(async () => undefined)) {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA, configurable: true },
    videoWidth: { value: 1920, configurable: true },
    videoHeight: { value: 1080, configurable: true },
  });
  video.play = vi.fn(async () => undefined);
  video.pause = vi.fn();

  const context = { filter: "none", drawImage: vi.fn() };
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getContext", {
    configurable: true,
    value: vi.fn(() => context),
  });
  canvas.toBlob = vi.fn((callback) => {
    callback(new Blob(["RIFFxxxxWEBPpreview"], { type: "image/webp" }));
  });

  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const clearTimer = vi.fn();
  const deps: StreamPreviewPublisherDeps = {
    createVideo: () => video,
    createCanvas: () => canvas,
    createStream: () => new Blob(),
    upload,
    setTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    clearTimer,
  };
  return { deps, video, canvas, context, timers, clearTimer, upload };
}

beforeEach(() => vi.clearAllMocks());

describe("stream preview publishing", () => {
  it("immediately captures a bounded, blurred WebP and schedules the next refresh after completion", async () => {
    const h = harness();
    const publisher = new StreamPreviewPublisher("server-1", "preview-1", track("one"), h.deps);

    publisher.start();

    await vi.waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
    expect(h.canvas.width).toBe(640);
    expect(h.canvas.height).toBe(360);
    expect(h.context.filter).toBe("blur(8px)");
    expect(h.context.drawImage).toHaveBeenCalledWith(h.video, -16, -16, 672, 392);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.delayMs).toBe(LIMITS.streamPreviewRefreshMs);
  });

  it("serializes refreshes and captures a replacement track as soon as the in-flight upload ends", async () => {
    const first = deferred();
    const second = deferred();
    const upload = vi
      .fn<StreamPreviewPublisherDeps["upload"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const h = harness(upload);
    const publisher = new StreamPreviewPublisher("server-1", "preview-1", track("one"), h.deps);
    publisher.start();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));

    publisher.replaceTrack(track("two"));
    expect(upload).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(h.timers).toHaveLength(0);

    second.resolve();
    await vi.waitFor(() => expect(h.timers).toHaveLength(1));
  });

  it("aborts and releases the detached video when the publication stops", async () => {
    const h = harness();
    const publisher = new StreamPreviewPublisher("server-1", "preview-1", track("one"), h.deps);
    publisher.start();
    await vi.waitFor(() => expect(h.timers).toHaveLength(1));

    publisher.stop();

    expect(h.clearTimer).toHaveBeenCalledWith(1);
    expect(h.video.pause).toHaveBeenCalledTimes(1);
    expect(h.video.srcObject).toBeNull();
  });
});
