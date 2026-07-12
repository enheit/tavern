import { CreateChatImageResponse, type ImageAttachment, LIMITS } from "@tavern/shared";
import { authTransport } from "@/lib/authTransport";

// § chat image paste: turn a pasted image blob into an `ImageAttachment`. The blob is decoded, capped
// to `chatImageMaxDimPx` on its longest edge, and re-encoded to webp (client-side) so the stored object
// is bounded + metadata-stripped and the server can serve a single content-type — exactly like the
// screenshot capture path. The webp bytes are PUT to R2 via the member-gated route, which returns the
// image id; the caller then sends `chat.send` with the returned `ImageAttachment`.

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

// Longest-edge downscale so a huge paste (e.g. an 8000px screenshot) becomes a sane chat image while
// preserving aspect ratio. Returns the source dims unchanged when already within the cap.
function fitWithin(width: number, height: number, maxDim: number): { w: number; h: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDim) return { w: width, h: height };
  const scale = maxDim / longest;
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

function toWebpBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
}

// Decode → (optionally) downscale → webp. Throws if the browser can't decode the blob or encode webp.
async function encodeWebp(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { w, h } = fitWithin(bitmap.width, bitmap.height, LIMITS.chatImageMaxDimPx);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const out = await toWebpBlob(canvas);
    if (out === null) throw new Error("webp encode failed");
    return { blob: out, width: w, height: h };
  } finally {
    bitmap.close();
  }
}

// Upload a pasted/dropped image FILE (raw bytes) and resolve the `ImageAttachment` to attach to a chat
// message. Throws on a decode/encode failure, an oversize encode, or a non-2xx upload — the caller
// toasts + aborts the send.
export async function uploadChatImage(serverId: string, file: Blob): Promise<ImageAttachment> {
  const { blob, width, height } = await encodeWebp(file);
  if (blob.size > LIMITS.chatImageMaxBytes) throw new Error("image too large");

  const res = await fetch(`${API_BASE}/api/servers/${serverId}/chat-images`, {
    method: "POST",
    headers: { ...(await authTransport.getAuthHeaders()), "Content-Type": "image/webp" },
    body: blob,
    credentials: "include",
  });
  await authTransport.storeFromResponse(res.headers);
  if (!res.ok) throw new Error(`chat image upload failed: ${res.status}`);
  const { id } = CreateChatImageResponse.parse(await res.json());
  return { id, width, height };
}

// Measure an image URL's intrinsic size by loading it in a detached <img>. An <img> load is CORS-exempt
// (unlike fetch), so this works for a cross-origin URL — we read only its dimensions, never its pixels.
function loadImageDims(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener(
      "load",
      () =>
        resolve({ width: Math.max(1, img.naturalWidth), height: Math.max(1, img.naturalHeight) }),
      { once: true },
    );
    img.addEventListener("error", () => reject(new Error("image load failed")), { once: true });
    img.src = url;
  });
}

// Upload an image the client could only obtain as a URL (a cross-app browser drag that carried no file
// bytes). The BROWSER never fetches the bytes (that would be cross-origin → CORS); it measures the size
// via a CORS-exempt <img> load, then the WORKER fetches + stores the bytes. Throws if the image can't be
// loaded (so we never send a broken attachment) or the ingest fails.
export async function uploadChatImageFromUrl(
  serverId: string,
  url: string,
): Promise<ImageAttachment> {
  const { width, height } = await loadImageDims(url);
  const res = await fetch(`${API_BASE}/api/servers/${serverId}/chat-images/from-url`, {
    method: "POST",
    headers: { ...(await authTransport.getAuthHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ url, width, height }),
    credentials: "include",
  });
  await authTransport.storeFromResponse(res.headers);
  if (!res.ok) throw new Error(`chat image ingest failed: ${res.status}`);
  const { id } = CreateChatImageResponse.parse(await res.json());
  return { id, width, height };
}

// The first image FILE on a DataTransfer (a drop's `files`/`items` OR a paste's clipboardData) — the
// byte-based path. Prefers the FileList (populated by file-system drops and most cross-app browser
// drags), then file-kind items (clipboard pastes). Null when the transfer carries no image bytes.
export function firstImageFile(dt: DataTransfer | null | undefined): File | null {
  if (!dt) return null;
  for (const f of Array.from(dt.files ?? [])) {
    if (f.type.startsWith("image/")) return f;
  }
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

// The first image URL on a DataTransfer when no file bytes were provided (a URL-only cross-app drag).
// Reads `text/uri-list` (or a URL-shaped `text/plain`). MUST be called synchronously in the drop
// handler — a DataTransfer's string data is only readable while the event is being dispatched.
export function firstImageUrl(dt: DataTransfer | null | undefined): string | null {
  if (!dt) return null;
  const fromList = dt
    .getData("text/uri-list")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (fromList) return fromList;
  const text = dt.getData("text/plain").trim();
  return /^(https?:|data:image\/)/i.test(text) ? text : null;
}

// The public, unauthenticated capability URL for a chat image (keyed by two UUIDs) — used for BOTH the
// inline thumbnail and the open-in-new-tab link, so viewing works identically in the web app and the
// Electron→OS-browser path (mirrors the screenshot view URL).
export function chatImageViewUrl(serverId: string, id: string): string {
  return `${API_BASE}/api/chat-images/${serverId}/${id}.webp`;
}
