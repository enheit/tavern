import type { StreamInfo } from "@tavern/shared";
import { Maximize2Icon, Minimize2Icon, MonitorIcon, VideoIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { getVoiceController } from "@/features/voice/voiceController";
import { useVolumeScroll } from "@/features/volume/useVolumeScroll";
import { focusStore } from "@/lib/focusState";
import { cn } from "@/lib/utils";
import { registerQualityVideoElement, useQualityStore } from "@/media/qualityMonitor";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useStreamPreview } from "./useStreamPreview";
import { useWatch } from "./useWatch";

function setStreamVolume(streamKey: string, level: number): void {
  getVoiceController().streamAudioSink()?.setStreamVolume(streamKey, level);
  const settings = useSettingsStore.getState();
  settings.setVolumes({
    ...settings.volumes,
    streams: { ...settings.volumes.streams, [streamKey]: level },
  });
}

export function StreamTile({
  stream,
  onToggleFocus,
  selfStream,
  fullscreen = false,
  compact = false,
  showStats = false,
  onToggleFullscreen,
}: {
  stream: StreamInfo;
  onToggleFocus: () => void;
  selfStream?: MediaStream | null;
  fullscreen?: boolean;
  compact?: boolean;
  showStats?: boolean;
  onToggleFullscreen: () => void;
}) {
  const selfUserId = useSessionStore((state) => state.profile?.userId);
  if (stream.userId === selfUserId) {
    return (
      <SelfTile
        stream={stream}
        selfStream={selfStream ?? null}
        onToggleFocus={onToggleFocus}
        fullscreen={fullscreen}
        compact={compact}
        onToggleFullscreen={onToggleFullscreen}
      />
    );
  }
  return (
    <RemoteTile
      stream={stream}
      onToggleFocus={onToggleFocus}
      fullscreen={fullscreen}
      compact={compact}
      showStats={showStats}
      onToggleFullscreen={onToggleFullscreen}
    />
  );
}

function FullscreenButton({
  trackName,
  fullscreen,
  onToggle,
}: {
  trackName: string;
  fullscreen: boolean;
  onToggle: () => void;
}) {
  const Icon = fullscreen ? Minimize2Icon : Maximize2Icon;
  const label = fullscreen ? m.streams_exit_fullscreen() : m.streams_fullscreen();
  return (
    <Button
      size="icon-xs"
      variant="secondary"
      className="ml-auto"
      data-testid={`stream-fullscreen-${trackName}`}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <Icon />
    </Button>
  );
}

function bitrateLabel(kbps: number | null): string {
  if (kbps === null) return "— kbps";
  if (kbps >= 1_000) return `${(kbps / 1_000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

function StreamStatsOverlay({ trackName }: { trackName: string }) {
  const quality = useQualityStore((state) => state.snapshots[trackName]);
  const [expanded, setExpanded] = useState(false);
  if (quality === undefined) return null;
  const resolution =
    quality.width === null || quality.height === null
      ? quality.height === null
        ? "—"
        : `${quality.height}p`
      : `${quality.width}×${quality.height}`;
  const cadence = quality.fps === null ? "—" : `${Math.round(quality.fps)} fps`;
  const codec = quality.codec ?? "—";
  return (
    <button
      type="button"
      data-testid={`stream-stats-${trackName}`}
      data-health={quality.health}
      aria-label={m.streams_stats()}
      aria-expanded={expanded}
      title={m.streams_stats()}
      onClick={(event) => {
        event.stopPropagation();
        setExpanded((value) => !value);
      }}
      className={cn(
        "absolute top-2 right-2 z-10 flex max-w-[calc(100%_-_1rem)] items-center gap-1.5 rounded-md border border-white/15 bg-black/75 px-2 py-1 text-xs font-medium whitespace-nowrap text-white shadow-lg backdrop-blur-sm",
        quality.health === "healthy" && "text-emerald-300",
        quality.health === "adapting" && "text-amber-200",
        (quality.health === "device_limited" || quality.health === "network_limited") &&
          "text-orange-300",
        quality.health === "poor" && "text-red-300",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      <span>{codec}</span>
      <span>·</span>
      <span>{resolution}</span>
      <span>·</span>
      <span>{cadence}</span>
      {expanded && (
        <>
          <span>·</span>
          <span>{bitrateLabel(quality.bitrateKbps)}</span>
        </>
      )}
    </button>
  );
}

type PreviewState = "live" | "suspended" | "resuming";

function SelfTile({
  stream,
  selfStream,
  onToggleFocus,
  fullscreen,
  compact,
  onToggleFullscreen,
}: {
  stream: StreamInfo;
  selfStream: MediaStream | null;
  onToggleFocus: () => void;
  fullscreen: boolean;
  compact: boolean;
  onToggleFullscreen: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewActive = useStore(focusStore, (state) => state.focused);
  const [previewState, setPreviewState] = useState<PreviewState>(
    previewActive ? "resuming" : "suspended",
  );

  const resumePreview = useCallback(() => {
    const element = videoRef.current;
    if (element === null || selfStream === null) return;
    element.srcObject = selfStream;
    setPreviewState("resuming");
  }, [selfStream]);

  // Detaching the muted local preview saves decode/paint work only. It never stops source tracks or
  // touches the publisher PeerConnection, so alt-tabbing into a game keeps the outgoing stream live.
  // This can react to keyboard focus because it affects only the local preview; remote delivery below
  // deliberately uses document visibility so a watched stream on monitor two stays at full quality.
  useLayoutEffect(() => {
    const element = videoRef.current;
    if (element === null) return;
    if (!previewActive || selfStream === null) {
      element.pause();
      element.srcObject = null;
      setPreviewState("suspended");
      return;
    }
    resumePreview();
  }, [previewActive, resumePreview, selfStream]);

  useEffect(() => {
    const element = videoRef.current;
    if (element === null) return;
    return registerQualityVideoElement(stream.trackName, element);
  }, [stream.trackName]);

  return (
    <div
      data-testid={`stream-tile-${stream.trackName}`}
      data-self="true"
      data-preview-state={previewState}
      onClick={onToggleFocus}
      className="group relative flex h-full min-h-0 w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-black/90"
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        data-testid={`stream-self-${stream.trackName}`}
        onPlaying={() => setPreviewState("live")}
        className="h-full w-full object-contain"
      />
      {selfStream !== null && !previewActive && (
        <PreviewPausedCover stream={stream} compact={compact} />
      )}
      <span
        data-testid={`stream-self-badge-${stream.trackName}`}
        className={cn(
          "absolute top-2 left-2 rounded bg-black/60 font-medium text-white",
          compact ? "px-1.5 py-0.5 text-[10px]" : "px-1.5 py-0.5 text-xs",
        )}
      >
        {m.streams_self()}
      </span>
      {!compact && (
        <TileOverlay fullscreen={fullscreen} compact={false}>
          <FullscreenButton
            trackName={stream.trackName}
            fullscreen={fullscreen}
            onToggle={onToggleFullscreen}
          />
        </TileOverlay>
      )}
    </div>
  );
}

function PreviewPausedCover({ stream, compact }: { stream: StreamInfo; compact: boolean }) {
  const KindIcon = stream.kind === "screen" ? MonitorIcon : VideoIcon;
  return (
    <div
      data-testid={`stream-self-paused-${stream.trackName}`}
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center bg-neutral-900 text-center",
        compact ? "gap-1.5 px-2" : "gap-3 px-6",
      )}
    >
      <span
        className={cn(
          "relative flex items-center justify-center rounded-full bg-white/10 text-white/90",
          compact ? "size-9" : "size-14",
        )}
      >
        <KindIcon className={compact ? "size-4" : "size-6"} />
        <span className="absolute -top-0.5 -right-0.5 flex size-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex size-3 rounded-full bg-emerald-500" />
        </span>
      </span>
      {!compact && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-white">{m.streams_preview_paused_title()}</p>
          <p className="text-xs text-white/55">{m.streams_preview_paused_body()}</p>
        </div>
      )}
    </div>
  );
}

function TileOverlay({
  fullscreen,
  compact,
  children,
}: {
  fullscreen: boolean;
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "absolute inset-x-0 bottom-0 flex items-center bg-gradient-to-t from-black/80 to-transparent transition-opacity",
        compact ? "gap-1 p-1.5 opacity-100" : "gap-2 p-2",
        !compact && (fullscreen ? "opacity-100" : "opacity-0 group-hover:opacity-100"),
      )}
    >
      {fullscreen && !compact && (
        <span className="shrink-0 text-xs text-white/70">{m.streams_fullscreen_hint()}</span>
      )}
      {children}
    </div>
  );
}

function RemoteTile({
  stream,
  onToggleFocus,
  fullscreen,
  compact,
  showStats,
  onToggleFullscreen,
}: {
  stream: StreamInfo;
  onToggleFocus: () => void;
  fullscreen: boolean;
  compact: boolean;
  showStats: boolean;
  onToggleFullscreen: () => void;
}) {
  const { state, mediaStream, watch, unwatch } = useWatch(stream);
  const watching = state !== "idle";
  const streamKey = `${stream.userId}:${stream.kind}`;
  const serverId = useServersStore((serversState) => serversState.activeServerId) ?? "";
  const ownerName = useStore(roomStore(serverId), (roomState) => {
    const member = roomState.members.find((candidate) => candidate.userId === stream.userId);
    return member?.displayName ?? stream.userId.slice(0, 8);
  });
  const { ref } = useVolumeScroll<HTMLDivElement>({
    enabled: watching && stream.hasAudio,
    read: () => useSettingsStore.getState().volumes.streams[streamKey] ?? 1,
    write: (level) => setStreamVolume(streamKey, level),
    meta: () => ({ key: streamKey, label: ownerName }),
  });

  const stopWatching = useCallback(() => {
    if (fullscreen) onToggleFullscreen();
    unwatch();
  }, [fullscreen, onToggleFullscreen, unwatch]);

  return (
    <div
      ref={ref}
      data-testid={`stream-tile-${stream.trackName}`}
      data-watching={watching}
      onClick={watching ? onToggleFocus : undefined}
      className={cn(
        "group relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-lg bg-black/90",
        watching && "cursor-pointer",
      )}
    >
      {watching ? (
        <WatchingView
          stream={stream}
          streamKey={streamKey}
          state={state}
          mediaStream={mediaStream}
          onUnwatch={stopWatching}
          fullscreen={fullscreen}
          compact={compact}
          showStats={showStats}
          onToggleFullscreen={onToggleFullscreen}
        />
      ) : (
        <Placeholder stream={stream} compact={compact} onWatch={watch} />
      )}
    </div>
  );
}

function WatchingView({
  stream,
  streamKey,
  state,
  mediaStream,
  onUnwatch,
  fullscreen,
  compact,
  showStats,
  onToggleFullscreen,
}: {
  stream: StreamInfo;
  streamKey: string;
  state: "connecting" | "watching";
  mediaStream: MediaStream | null;
  onUnwatch: () => void;
  fullscreen: boolean;
  compact: boolean;
  showStats: boolean;
  onToggleFullscreen: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = videoRef.current;
    if (element !== null) element.srcObject = mediaStream;
  }, [mediaStream]);
  useEffect(() => {
    const element = videoRef.current;
    if (element === null) return;
    return registerQualityVideoElement(stream.trackName, element);
  }, [stream.trackName]);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        data-testid={`stream-video-${stream.trackName}`}
        className="h-full w-full object-contain"
      />
      {state === "connecting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-900 px-3 text-center text-white/75">
          <MonitorIcon className={compact ? "size-5" : "size-8"} />
          <span className={compact ? "text-[11px]" : "text-sm"}>{m.streams_connecting()}</span>
        </div>
      )}
      {showStats && !compact && <StreamStatsOverlay trackName={stream.trackName} />}
      <TileOverlay fullscreen={fullscreen} compact={compact}>
        <Button
          size="xs"
          variant="secondary"
          className={compact ? "h-7 max-w-full px-2 text-[11px]" : undefined}
          data-testid={`stream-unwatch-${stream.trackName}`}
          onClick={onUnwatch}
        >
          {m.streams_unwatch()}
        </Button>
        {stream.hasAudio && !compact && <StreamVolume streamKey={streamKey} />}
        {!compact && (
          <FullscreenButton
            trackName={stream.trackName}
            fullscreen={fullscreen}
            onToggle={onToggleFullscreen}
          />
        )}
      </TileOverlay>
    </>
  );
}

function StreamVolume({ streamKey }: { streamKey: string }) {
  const level = useSettingsStore((state) => state.volumes.streams[streamKey] ?? 1);
  const percent = Math.round(level * 100);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" title={m.streams_volume()}>
      <Slider
        value={[percent]}
        min={0}
        max={200}
        step={5}
        aria-label={m.streams_volume()}
        data-testid={`stream-volume-${streamKey}`}
        onValueChange={(value) => {
          const next = Array.isArray(value) ? (value[0] ?? 0) : value;
          setStreamVolume(streamKey, next / 100);
        }}
      />
      <span
        data-testid={`stream-volume-percent-${streamKey}`}
        className="w-10 shrink-0 text-right text-xs text-white/80 tabular-nums"
      >
        {percent}%
      </span>
    </div>
  );
}

function Placeholder({
  stream,
  compact,
  onWatch,
}: {
  stream: StreamInfo;
  compact: boolean;
  onWatch: () => void;
}) {
  const serverId = useServersStore((serversState) => serversState.activeServerId) ?? "";
  const previewUrl = useStreamPreview(serverId, stream.preview);
  const member = useStore(roomStore(serverId), (roomState) =>
    roomState.members.find((candidate) => candidate.userId === stream.userId),
  );
  const name = member?.displayName ?? stream.userId.slice(0, 8);
  const color = member?.color ?? "#888888";
  const KindIcon = stream.kind === "screen" ? MonitorIcon : VideoIcon;
  return (
    <div
      data-testid={`stream-placeholder-${stream.trackName}`}
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center text-center",
        compact ? "gap-1.5 p-2" : "gap-3 p-4",
      )}
      style={{ backgroundColor: `color-mix(in srgb, ${color} 28%, #18181b)` }}
    >
      {previewUrl !== null && (
        <img
          src={previewUrl}
          alt=""
          aria-hidden={true}
          data-testid={`stream-preview-image-${stream.trackName}`}
          className="absolute inset-0 h-full w-full scale-105 object-cover blur-sm"
        />
      )}
      {previewUrl !== null && (
        <span
          aria-hidden={true}
          data-testid={`stream-preview-shade-${stream.trackName}`}
          className="absolute inset-0 bg-black/55"
        />
      )}
      {stream.preview !== undefined && !compact && (
        <span className="absolute top-2 left-2 z-10 rounded bg-black/70 px-2 py-1 text-xs font-medium text-white">
          {m.streams_preview()}
        </span>
      )}
      <span
        className={cn("relative z-10 flex flex-col items-center", compact ? "gap-1.5" : "gap-3")}
      >
        <span className="relative">
          <span
            data-testid={`stream-avatar-${stream.trackName}`}
            className={cn(
              "flex items-center justify-center rounded-full font-medium text-white",
              compact ? "size-9 text-sm" : "size-14 text-lg",
            )}
            style={{ backgroundColor: color }}
          >
            {name.charAt(0)}
          </span>
          <span className="absolute -right-1 -bottom-1 rounded-full bg-background p-1 text-foreground">
            <KindIcon
              data-testid={`stream-kind-${stream.trackName}`}
              className={compact ? "size-3" : "size-3.5"}
            />
          </span>
        </span>
        <span
          className={cn("max-w-32 truncate font-medium", compact ? "text-xs" : "text-sm")}
          style={{ color: previewUrl === null ? color : "white" }}
        >
          {name}
        </span>
        <Button
          size={compact ? "xs" : "sm"}
          className={compact ? "h-7 px-2 text-[11px]" : undefined}
          data-testid={`stream-watch-${stream.trackName}`}
          onClick={onWatch}
        >
          {m.streams_watch()}
        </Button>
      </span>
    </div>
  );
}
