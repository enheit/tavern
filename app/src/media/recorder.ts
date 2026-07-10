import { LIMITS, OpenRecordingResponse, UploadPartResponse } from "@tavern/shared";
import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import type { AudioGraph } from "./audioGraph";

// FR-25 client recorder (§7.4). Shape pinned by S7.2 — do NOT redefine `RecorderChunkSink` /
// `VoiceRecorder`'s constructor+start+stop+active. S9.3 fills the body + adds the R2 multipart sink,
// the upload API contract, and its concrete fetch transport.
export interface RecorderChunkSink {
  onPart(partNumber: number, bytes: Uint8Array, isFinal: boolean): Promise<void>;
}

const MIME = "audio/webm;codecs=opus";

// Concatenate a chunk list into one buffer of the given total length (only run when a part fills, so
// the O(part-size) copy happens once every recordingPartBytes, not per timeslice).
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export class VoiceRecorder {
  private started = false;
  private readonly graph: AudioGraph;
  private recorder: MediaRecorder | null = null;
  private sink: RecorderChunkSink | null = null;
  // Byte queue: opus/webm timeslice blobs accumulate here; a full part is sliced off at exactly
  // recordingPartBytes (R2 multipart requires equal non-final parts — §7.4).
  private chunks: Uint8Array[] = [];
  private queuedLen = 0;
  private partNumber = 1;
  private startedAt = 0;
  // Serializes part handling so onPart calls stay sequential (one part in-flight) even though each
  // `dataavailable` fires independently.
  private pump: Promise<void> = Promise.resolve();

  constructor(deps: { graph: AudioGraph }) {
    this.graph = deps.graph;
  }

  get active(): boolean {
    return this.started;
  }

  start(localMic: MediaStreamTrack, sink: RecorderChunkSink): void {
    // Guarded at construction: the pinned Electron 43 / Chromium 150 runtime supports opus/webm.
    if (!MediaRecorder.isTypeSupported(MIME)) {
      throw new Error(`MediaRecorder does not support ${MIME}`);
    }
    this.sink = sink;
    this.chunks = [];
    this.queuedLen = 0;
    this.partNumber = 1;
    this.pump = Promise.resolve();
    const mix = this.graph.mixForRecording(localMic);
    const recorder = new MediaRecorder(mix, { mimeType: MIME });
    recorder.addEventListener("dataavailable", (event) => {
      this.enqueue(event.data);
    });
    this.recorder = recorder;
    this.startedAt = Date.now();
    recorder.start(LIMITS.recordingTimesliceMs);
    this.started = true;
  }

  private enqueue(blob: Blob): void {
    this.pump = this.pump.then(() => this.handleBlob(blob));
  }

  private async handleBlob(blob: Blob): Promise<void> {
    const sink = this.sink;
    if (sink === null) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length > 0) {
      this.chunks.push(bytes);
      this.queuedLen += bytes.length;
    }
    // Slice every full part synchronously, then upload them one-in-flight via a then-ladder — keeps the
    // await out of the loop (§9.10) while preserving order (mirrors the §S3.4 alarm's sequential chain).
    const fullParts: Array<{ n: number; bytes: Uint8Array }> = [];
    while (this.queuedLen >= LIMITS.recordingPartBytes) {
      const merged = concat(this.chunks, this.queuedLen);
      const part = merged.slice(0, LIMITS.recordingPartBytes);
      const rest = merged.slice(LIMITS.recordingPartBytes);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.queuedLen = rest.length;
      fullParts.push({ n: this.partNumber, bytes: part });
      this.partNumber += 1;
    }
    await fullParts.reduce<Promise<void>>(
      (chain, item) => chain.then(() => sink.onPart(item.n, item.bytes, false)),
      Promise.resolve(),
    );
  }

  // Stops the MediaRecorder (flushing its final `dataavailable`), drains the queue, and hands the
  // remainder as the final part. Returns the measured wall-clock duration for the caller's finalize.
  async stop(): Promise<{ durationMs: number }> {
    const recorder = this.recorder;
    const sink = this.sink;
    if (recorder !== null) {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }
    await this.pump; // ensure every buffered timeslice (incl. the stop-flush) is processed
    const durationMs = this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
    if (sink !== null) {
      const rest = concat(this.chunks, this.queuedLen);
      this.chunks = [];
      this.queuedLen = 0;
      await sink.onPart(this.partNumber, rest, true);
      this.partNumber += 1;
    }
    this.graph.releaseRecordingMix();
    this.started = false;
    this.recorder = null;
    this.sink = null;
    return { durationMs };
  }
}

// ---- S9.3 R2 multipart sink + upload API (the open / uploadId-holding wiring) ----

export type RecorderState = "idle" | "recording" | "finishing" | "error";

export interface RecordingUploadApi {
  open(): Promise<{ recordingId: string; uploadId: string }>; // POST /api/servers/:id/recordings
  uploadPart(
    recordingId: string,
    n: number,
    bytes: Uint8Array,
    final: boolean,
  ): Promise<{ etag: string }>;
  complete(
    recordingId: string,
    parts: { partNumber: number; etag: string }[],
    durationMs: number,
  ): Promise<void>;
  abort(recordingId: string): Promise<void>;
}

const RETRY_BACKOFF_MS = [1000, 2000, 4000] as const; // ×3 retries after the initial attempt (§7.4)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class R2MultipartSink implements RecorderChunkSink {
  private recId: string | null = null;
  private uploadId: string | null = null;
  private readonly parts: { partNumber: number; etag: string }[] = [];
  private opening: Promise<void> | null = null;
  private errored = false;

  constructor(
    private readonly api: RecordingUploadApi,
    private readonly onState: (s: RecorderState) => void,
  ) {}

  get recordingId(): string | null {
    return this.recId;
  }

  // Opens the multipart lazily on the first part, then uploads sequentially with ×3 retry. On give-up
  // it aborts + flips to 'error' and swallows further parts (the recorder is torn down by the caller).
  async onPart(partNumber: number, bytes: Uint8Array, isFinal: boolean): Promise<void> {
    void isFinal; // the final flag rides the query string in the concrete api; the sink treats parts uniformly
    if (this.errored) return;
    await this.ensureOpen();
    const recId = this.recId;
    if (this.errored || recId === null) return;
    const etag = await this.uploadWithRetry(recId, partNumber, bytes, isFinal);
    if (etag !== null) this.parts.push({ partNumber, etag });
  }

  // Called by the caller with the measured duration from VoiceRecorder.stop() → completes the upload.
  async finish(durationMs: number): Promise<void> {
    if (this.errored || this.recId === null || this.uploadId === null) return;
    this.onState("finishing");
    await this.api.complete(this.recId, this.parts, durationMs);
    this.onState("idle");
  }

  private async ensureOpen(): Promise<void> {
    if (this.uploadId !== null || this.errored) return;
    if (this.opening === null) this.opening = this.doOpen();
    await this.opening;
  }

  private async doOpen(): Promise<void> {
    this.onState("recording");
    const opened = await this.api.open();
    this.recId = opened.recordingId;
    this.uploadId = opened.uploadId;
  }

  private uploadWithRetry(
    recordingId: string,
    n: number,
    bytes: Uint8Array,
    final: boolean,
  ): Promise<string | null> {
    return this.attemptUpload(recordingId, n, bytes, final, 0);
  }

  // Recursive so the retry backoff never awaits inside a loop (§9.10); depth is bounded by the ×3
  // backoff table. On the final failure it aborts the multipart + flips to 'error'.
  private async attemptUpload(
    recordingId: string,
    n: number,
    bytes: Uint8Array,
    final: boolean,
    attempt: number,
  ): Promise<string | null> {
    try {
      const { etag } = await this.api.uploadPart(recordingId, n, bytes, final);
      return etag;
    } catch {
      const delay = RETRY_BACKOFF_MS[attempt];
      if (delay === undefined) {
        this.errored = true;
        await this.api.abort(recordingId);
        this.onState("error");
        return null;
      }
      await sleep(delay);
      return this.attemptUpload(recordingId, n, bytes, final, attempt + 1);
    }
  }
}

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

// The concrete transport (§4: recorder.ts owns the chunked upload). `open` is JSON both ways (shared
// apiClient); `uploadPart` streams raw bytes with the R2 uploadId on the query string (the Worker
// stays stateless); `complete`/`abort` are body-less 204s, so they use a thin authed fetch.
export function createRecordingUploadApi(serverId: string): RecordingUploadApi {
  let uploadId: string | null = null;
  const base = `/api/servers/${serverId}/recordings`;
  return {
    async open() {
      const res = await apiClient.post(base, OpenRecordingResponse);
      uploadId = res.uploadId;
      return res;
    },
    async uploadPart(recordingId, n, bytes, final) {
      if (uploadId === null) throw new Error("multipart not open");
      const headers = {
        ...(await authTransport.getAuthHeaders()),
        "content-type": "application/octet-stream",
      };
      const query = `n=${n}&uploadId=${encodeURIComponent(uploadId)}&final=${final ? 1 : 0}`;
      // Copy into an ArrayBuffer-backed view so the raw octets form a BodyInit Blob (the frozen
      // `Uint8Array` param is `Uint8Array<ArrayBufferLike>`, which the TS 7 DOM lib rejects) — no cast.
      const body = new Blob([new Uint8Array(bytes)]);
      const res = await fetch(`${API_BASE}${base}/${recordingId}/part?${query}`, {
        method: "PUT",
        headers,
        body,
        credentials: "include",
      });
      await authTransport.storeFromResponse(res.headers);
      if (!res.ok) throw new ApiError("bad_message", res.status);
      const parsed = UploadPartResponse.safeParse(await res.json());
      if (!parsed.success) throw new ApiError("bad_message", res.status);
      return parsed.data;
    },
    async complete(recordingId, parts, durationMs) {
      const headers = {
        ...(await authTransport.getAuthHeaders()),
        "content-type": "application/json",
      };
      const res = await fetch(`${API_BASE}${base}/${recordingId}/complete`, {
        method: "POST",
        headers,
        body: JSON.stringify({ parts, durationMs }),
        credentials: "include",
      });
      await authTransport.storeFromResponse(res.headers);
      if (!res.ok) throw new ApiError("bad_message", res.status);
    },
    async abort(recordingId) {
      const headers = await authTransport.getAuthHeaders();
      const res = await fetch(`${API_BASE}${base}/${recordingId}/abort`, {
        method: "POST",
        headers,
        credentials: "include",
      });
      await authTransport.storeFromResponse(res.headers);
      // Best-effort cleanup — a non-ok abort still lets the caller reset UI (§9.5: not swallowed
      // silently, the sink already surfaced 'error').
    },
  };
}
