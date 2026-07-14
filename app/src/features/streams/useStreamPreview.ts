import { LIMITS, type StreamPreview } from "@tavern/shared";
import { useEffect, useRef, useState } from "react";
import { authTransport } from "@/lib/authTransport";

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

type LoadedPreview = StreamPreview & { serverId: string; url: string };

async function fetchPreviewBlob(
  serverId: string,
  previewId: string,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(`${API_BASE}/api/servers/${serverId}/stream-previews/${previewId}`, {
    headers: await authTransport.getAuthHeaders(),
    credentials: "include",
    cache: "no-store",
    signal,
  });
  await authTransport.storeFromResponse(response.headers);
  if (!response.ok) throw new Error(`stream preview fetch failed: ${response.status}`);
  const blob = await response.blob();
  if (blob.type !== "image/webp" || blob.size > LIMITS.streamPreviewMaxBytes) {
    throw new Error("stream preview response was not a bounded WebP image");
  }
  return blob;
}

async function decodeObjectUrl(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  await image.decode();
}

function revoke(loaded: LoadedPreview | null): void {
  if (loaded !== null) URL.revokeObjectURL(loaded.url);
}

// Fetches only while the idle Placeholder is mounted. A new version is decoded before swapping, so a
// transient refresh failure keeps the prior teaser; a different publication clears immediately.
export function useStreamPreview(
  serverId: string,
  preview: StreamPreview | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const loadedRef = useRef<LoadedPreview | null>(null);
  const previewId = preview?.id;
  const previewVersion = preview?.version;

  useEffect(() => {
    const loaded = loadedRef.current;
    const publicationChanged =
      loaded !== null && (loaded.serverId !== serverId || loaded.id !== previewId);
    if (
      publicationChanged ||
      previewId === undefined ||
      previewVersion === undefined ||
      serverId === ""
    ) {
      revoke(loaded);
      loadedRef.current = null;
      setUrl(null);
    }
    if (previewId === undefined || previewVersion === undefined || serverId === "") return;
    if (
      loadedRef.current?.serverId === serverId &&
      loadedRef.current.id === previewId &&
      loadedRef.current.version === previewVersion
    ) {
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    void (async () => {
      let nextUrl: string | null = null;
      try {
        const blob = await fetchPreviewBlob(serverId, previewId, controller.signal);
        nextUrl = URL.createObjectURL(blob);
        await decodeObjectUrl(nextUrl);
        if (disposed) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        const previous = loadedRef.current;
        loadedRef.current = { id: previewId, version: previewVersion, serverId, url: nextUrl };
        setUrl(nextUrl);
        revoke(previous);
      } catch (error: unknown) {
        if (nextUrl !== null) URL.revokeObjectURL(nextUrl);
        if (!controller.signal.aborted) {
          console.error("stream preview fetch failed", {
            serverId,
            previewId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [previewId, previewVersion, serverId]);

  useEffect(
    () => () => {
      revoke(loadedRef.current);
      loadedRef.current = null;
    },
    [],
  );

  return url;
}
