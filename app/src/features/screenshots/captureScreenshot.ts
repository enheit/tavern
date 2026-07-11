import { toast } from "sonner";
import { authTransport } from "@/lib/authTransport";
import { m } from "@/paraglide/messages.js";

// § screenshots capture: grab the CURRENT frame of the focused stream's <video> and upload it as a
// single webp still. Space in the Canvas targets the fullscreen-or-focused stream (no focus → no-op);
// this helper does the DOM → canvas → R2 leg. The <video> is fed by a WebRTC/local MediaStream, which
// is origin-clean, so drawing it never taints the canvas (toBlob would otherwise throw a SecurityError).

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

// The tile renders the focused stream's frame under one of these testids (remote watched vs own stream).
function findStreamVideo(trackName: string): HTMLVideoElement | null {
  const el = document.querySelector(
    `[data-testid="stream-video-${trackName}"], [data-testid="stream-self-${trackName}"]`,
  );
  return el instanceof HTMLVideoElement ? el : null;
}

function toWebpBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.92));
}

async function uploadScreenshot(serverId: string, blob: Blob): Promise<void> {
  const res = await fetch(`${API_BASE}/api/servers/${serverId}/screenshots`, {
    method: "POST",
    headers: { ...(await authTransport.getAuthHeaders()), "Content-Type": "image/webp" },
    body: blob,
    credentials: "include",
  });
  await authTransport.storeFromResponse(res.headers);
  if (!res.ok) throw new Error(`screenshot upload failed: ${res.status}`);
}

// Capture + upload the focused stream's current frame. Self-contained (toasts its own success/failure)
// so the Canvas keydown handler just fires it. Returns once the round-trip settles; the Screenshots tab
// refreshes off the `screenshot.updated` broadcast the DO fans out on a successful create.
export async function captureStreamScreenshot(serverId: string, trackName: string): Promise<void> {
  const video = findStreamVideo(trackName);
  if (video === null || video.videoWidth === 0 || video.videoHeight === 0) {
    toast.error(m.screenshot_not_ready());
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    toast.error(m.screenshot_failed());
    return;
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  try {
    const blob = await toWebpBlob(canvas);
    if (blob === null) {
      toast.error(m.screenshot_failed());
      return;
    }
    await uploadScreenshot(serverId, blob);
    toast.success(m.screenshot_saved());
  } catch {
    toast.error(m.screenshot_failed());
  }
}
