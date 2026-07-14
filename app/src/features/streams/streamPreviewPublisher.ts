import { LIMITS, PutStreamPreviewResponse } from "@tavern/shared";
import { authTransport } from "@/lib/authTransport";

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";
const PREVIEW_QUALITY = 0.6;
const PREVIEW_BLUR_PX = 8;

export interface StreamPreviewPublication {
  replaceTrack(track: MediaStreamTrack): void;
  stop(): void;
}

export interface StreamPreviewPublisherDeps {
  createVideo(): HTMLVideoElement;
  createCanvas(): HTMLCanvasElement;
  createStream(track: MediaStreamTrack): MediaProvider;
  upload(serverId: string, previewId: string, blob: Blob, signal: AbortSignal): Promise<void>;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(timer: number): void;
}

async function uploadPreview(
  serverId: string,
  previewId: string,
  blob: Blob,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}/api/servers/${serverId}/stream-previews/${previewId}`, {
    method: "PUT",
    headers: { ...(await authTransport.getAuthHeaders()), "Content-Type": "image/webp" },
    body: blob,
    credentials: "include",
    cache: "no-store",
    signal,
  });
  await authTransport.storeFromResponse(response.headers);
  if (!response.ok) throw new Error(`stream preview upload failed: ${response.status}`);
  const parsed = PutStreamPreviewResponse.safeParse(await response.json());
  if (!parsed.success || parsed.data.preview.id !== previewId) {
    throw new Error("stream preview upload returned an invalid response");
  }
}

const defaultDeps: StreamPreviewPublisherDeps = {
  createVideo: () => document.createElement("video"),
  createCanvas: () => document.createElement("canvas"),
  createStream: (track) => new MediaStream([track]),
  upload: uploadPreview,
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timer) => window.clearTimeout(timer),
};

function canvasWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null || blob.type !== "image/webp") {
          reject(new Error("browser could not encode the stream preview as WebP"));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      PREVIEW_QUALITY,
    );
  });
}

export class StreamPreviewPublisher implements StreamPreviewPublication {
  private readonly deps: StreamPreviewPublisherDeps;
  private readonly video: HTMLVideoElement;
  private readonly abortController = new AbortController();
  private timer: number | null = null;
  private running = false;
  private refreshAfterCurrent = false;
  private started = false;
  private stopped = false;

  constructor(
    private readonly serverId: string,
    private readonly previewId: string,
    track: MediaStreamTrack,
    deps: StreamPreviewPublisherDeps = defaultDeps,
  ) {
    this.deps = deps;
    this.video = deps.createVideo();
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.setTrack(track);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.refresh();
  }

  replaceTrack(track: MediaStreamTrack): void {
    if (this.stopped) return;
    this.setTrack(track);
    if (!this.started) return;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.running) this.refreshAfterCurrent = true;
    else void this.refresh();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.video.pause();
    this.video.srcObject = null;
  }

  private setTrack(track: MediaStreamTrack): void {
    this.video.srcObject = this.deps.createStream(track);
  }

  private async readyFrame(): Promise<void> {
    if (
      this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      this.video.videoWidth > 0 &&
      this.video.videoHeight > 0
    ) {
      return;
    }
    await this.video.play();
    if (this.video.videoWidth > 0 && this.video.videoHeight > 0) return;
    await new Promise<void>((resolve, reject) => {
      const signal = this.abortController.signal;
      const cleanup = () => {
        this.video.removeEventListener("loadeddata", onReady);
        this.video.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("stream preview video failed to load"));
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      this.video.addEventListener("loadeddata", onReady, { once: true });
      this.video.addEventListener("error", onError, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) {
      throw new Error("stream preview video has no frame dimensions");
    }
  }

  private async capture(): Promise<Blob> {
    await this.readyFrame();
    const scale = Math.min(
      1,
      LIMITS.streamPreviewMaxWidthPx / this.video.videoWidth,
      LIMITS.streamPreviewMaxHeightPx / this.video.videoHeight,
    );
    const width = Math.max(1, Math.round(this.video.videoWidth * scale));
    const height = Math.max(1, Math.round(this.video.videoHeight * scale));
    const canvas = this.deps.createCanvas();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("stream preview canvas context is unavailable");

    // Bake the blur into the stored bytes. Drawing beyond the canvas trims the transparent blur fringe
    // that would otherwise expose a sharp border around the teaser.
    const bleed = PREVIEW_BLUR_PX * 2;
    context.filter = `blur(${PREVIEW_BLUR_PX}px)`;
    context.drawImage(this.video, -bleed, -bleed, width + bleed * 2, height + bleed * 2);
    const blob = await canvasWebp(canvas);
    if (blob.size > LIMITS.streamPreviewMaxBytes) {
      throw new Error(`stream preview exceeds ${LIMITS.streamPreviewMaxBytes} bytes`);
    }
    return blob;
  }

  private async refresh(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const blob = await this.capture();
      if (!this.stopped) {
        await this.deps.upload(this.serverId, this.previewId, blob, this.abortController.signal);
      }
    } catch (error: unknown) {
      if (!this.abortController.signal.aborted) {
        console.error("stream preview refresh failed", {
          serverId: this.serverId,
          previewId: this.previewId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.running = false;
      if (!this.stopped) {
        if (this.refreshAfterCurrent) {
          this.refreshAfterCurrent = false;
          queueMicrotask(() => void this.refresh());
        } else {
          this.timer = this.deps.setTimer(() => {
            this.timer = null;
            void this.refresh();
          }, LIMITS.streamPreviewRefreshMs);
        }
      }
    }
  }
}

export function startStreamPreview(
  serverId: string,
  previewId: string,
  track: MediaStreamTrack,
): StreamPreviewPublication {
  const publisher = new StreamPreviewPublisher(serverId, previewId, track);
  publisher.start();
  return publisher;
}
