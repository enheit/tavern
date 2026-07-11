import { useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { authTransport } from "@/lib/authTransport";
import { m } from "@/paraglide/messages.js";

// FR-25 custom recording player. A bare `<audio src controls>` cannot work here: the media route
// needs auth, and the desktop (Electron) session is a Bearer header the media element can never
// attach — so every request 401'd and the native player sat at 0:00/0:00. Instead the first play
// press fetches the whole WebM through the authed transport into a blob URL, and the row renders
// its own controls (toggle / seek / time) over a hidden audio element.
type Status = "idle" | "loading" | "ready" | "error";

function formatSeconds(sec: number): string {
  const total = Math.floor(sec);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

// Authed media download (mirrors the apiClient transport: bearer header + cookie + token capture).
async function fetchBlobUrl(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: await authTransport.getAuthHeaders(),
    credentials: "include",
  });
  await authTransport.storeFromResponse(res.headers);
  if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

function once(target: HTMLAudioElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (): void => reject(new Error("audio failed to decode"));
    target.addEventListener(
      event,
      () => {
        target.removeEventListener("error", onError);
        resolve();
      },
      { once: true },
    );
    target.addEventListener("error", onError, { once: true });
  });
}

// Recorded WebM has no Duration header (§7.4), so a blob URL first reports duration=Infinity.
// Seeking far past the end forces the browser to scan the clip: duration turns finite (and the
// seek index is built, so the slider works). No-op when the duration is already known.
async function resolveDuration(audio: HTMLAudioElement): Promise<void> {
  if (Number.isFinite(audio.duration)) return;
  const settled = new Promise<void>((resolve) => {
    const onChange = (): void => {
      if (!Number.isFinite(audio.duration)) return;
      audio.removeEventListener("durationchange", onChange);
      resolve();
    };
    audio.addEventListener("durationchange", onChange);
  });
  audio.currentTime = Number.MAX_SAFE_INTEGER;
  await settled;
  audio.currentTime = 0;
}

export function RecordingPlayer({
  recordingId,
  url,
  durationMs,
}: {
  recordingId: string;
  url: string;
  durationMs: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  // Until the clip is scanned, the stored metadata is the best total we have.
  const [total, setTotal] = useState((durationMs ?? 0) / 1000);

  // Pause + free the blob when the row unmounts (delete, tab switch).
  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (blobUrlRef.current !== null) URL.revokeObjectURL(blobUrlRef.current);
    },
    [],
  );

  const load = async (): Promise<void> => {
    const audio = audioRef.current;
    if (audio === null) return;
    setStatus("loading");
    try {
      const blobUrl = await fetchBlobUrl(url);
      blobUrlRef.current = blobUrl;
      audio.src = blobUrl;
      await once(audio, "loadedmetadata");
      await resolveDuration(audio);
      if (Number.isFinite(audio.duration)) setTotal(audio.duration);
      setStatus("ready");
      await audio.play();
    } catch {
      setStatus("error");
    }
  };

  const toggle = (): void => {
    const audio = audioRef.current;
    if (audio === null || status === "loading") return;
    if (status === "ready") {
      if (audio.paused) void audio.play();
      else audio.pause();
      return;
    }
    void load();
  };

  const seek = (value: number | readonly number[]): void => {
    const audio = audioRef.current;
    if (audio === null || status !== "ready") return;
    const t = typeof value === "number" ? value : (value[0] ?? 0);
    audio.currentTime = t;
    setNow(t);
  };

  return (
    <div className="flex items-center gap-2" data-testid={`recording-player-${recordingId}`}>
      <Button
        size="icon-sm"
        variant="ghost"
        data-testid={`recording-play-${recordingId}`}
        aria-label={playing ? m.recordings_pause() : m.recordings_play()}
        onClick={toggle}
      >
        {status === "loading" ? <Spinner /> : playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      {status === "error" ? (
        <span className="flex-1 text-xs text-destructive">{m.recordings_play_error()}</span>
      ) : (
        <>
          <Slider
            aria-label={m.recordings_seek()}
            data-testid={`recording-seek-${recordingId}`}
            className="min-w-0 flex-1"
            value={now}
            min={0}
            max={Math.max(total, 0.01)}
            step={0.1}
            disabled={status !== "ready"}
            onValueChange={seek}
          />
          <span
            data-testid={`recording-time-${recordingId}`}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {formatSeconds(now)} / {formatSeconds(total)}
          </span>
        </>
      )}
      <audio
        ref={audioRef}
        data-testid={`recording-audio-${recordingId}`}
        preload="none"
        onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setNow(0);
          const audio = audioRef.current;
          if (audio !== null) audio.currentTime = 0;
        }}
        className="hidden"
      />
    </div>
  );
}
