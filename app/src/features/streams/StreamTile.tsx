import type { StreamInfo } from "@tavern/shared";
import { Maximize2Icon, Minimize2Icon, MonitorIcon, VideoIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { getVoiceController } from "@/features/voice/voiceController";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useWatch } from "./useWatch";

// FR-31: apply the tile's per-stream gain to the shared graph AND persist it under
// settings.volumes.streams (keyed by the opaque userId:kind). Sliders map 0–200% → gain 0–2.
function setStreamVolume(streamKey: string, gain: number): void {
  getVoiceController().streamAudioSink()?.setStreamGain(streamKey, gain);
  const s = useSettingsStore.getState();
  s.setVolumes({ ...s.volumes, streams: { ...s.volumes.streams, [streamKey]: gain } });
}

// FR-29 self path: the sharer's OWN stream (`stream.userId === self.userId`) renders the LOCAL
// MediaStream directly — never a PullSession to self, never a Watch button (you don't watch yourself).
// Every other tile is a normal opt-in remote tile (FR-30 applies to webcams exactly as to screens).
export function StreamTile({
  stream,
  onToggleFocus,
  selfStream,
  fullscreen = false,
  onToggleFullscreen,
}: {
  stream: StreamInfo;
  onToggleFocus: () => void;
  selfStream?: MediaStream | null;
  // Theater fullscreen: `fullscreen` marks this tile as the window-filling instance (renders its
  // controls always-visible + a minimize affordance); `onToggleFullscreen` enters/exits it.
  fullscreen?: boolean;
  onToggleFullscreen: () => void;
}) {
  const selfUserId = useSessionStore((s) => s.profile?.userId);
  if (stream.userId === selfUserId) {
    return (
      <SelfTile
        stream={stream}
        selfStream={selfStream ?? null}
        onToggleFocus={onToggleFocus}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
    );
  }
  return (
    <RemoteTile
      stream={stream}
      onToggleFocus={onToggleFocus}
      fullscreen={fullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  );
}

// Enter/exit theater fullscreen for one stream. Lives bottom-left of a watched/self tile's overlay;
// stops propagation so it never also toggles the tile's focus. Icon flips maximize ↔ minimize.
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
      data-testid={`stream-fullscreen-${trackName}`}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon />
    </Button>
  );
}

// FR-29 self-preview: the local webcam (or any own stream) shown muted with a "You" badge. No Watch
// button and no useWatch — the sharer sees their own tile without pulling from the SFU. On-the-fly
// quality (FR-27) is driven from the ControlsBar res/fps groups now, not a per-tile dropdown. FR-33: a
// single left-click escalates the layout (grid → main → fullscreen ↔ main; the Canvas decides), same
// as a remote tile — there is no simulcast layer to switch (the stream is local), purely layout.
function SelfTile({
  stream,
  selfStream,
  onToggleFocus,
  fullscreen,
  onToggleFullscreen,
}: {
  stream: StreamInfo;
  selfStream: MediaStream | null;
  onToggleFocus: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.srcObject = selfStream;
  }, [selfStream]);
  return (
    <div
      data-testid={`stream-tile-${stream.trackName}`}
      data-self="true"
      onClick={onToggleFocus}
      className="group relative flex h-full min-h-0 w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-black/90"
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        data-testid={`stream-self-${stream.trackName}`}
        className="h-full w-full object-contain"
      />
      <span
        data-testid={`stream-self-badge-${stream.trackName}`}
        className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white"
      >
        {m.streams_self()}
      </span>
      <TileOverlay fullscreen={fullscreen}>
        <FullscreenButton
          trackName={stream.trackName}
          fullscreen={fullscreen}
          onToggle={onToggleFullscreen}
        />
      </TileOverlay>
    </div>
  );
}

// The bottom control strip shared by self + watched tiles: hover-revealed in the grid, pinned visible
// while fullscreen (so the minimize affordance + Esc hint are always reachable). Clicks inside never
// bubble to the tile's focus toggle. Renders the Esc hint on the right when fullscreen.
function TileOverlay({ fullscreen, children }: { fullscreen: boolean; children: ReactNode }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 transition-opacity",
        fullscreen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    >
      {children}
      {fullscreen && (
        <span className="ml-auto shrink-0 text-xs text-white/70">
          {m.streams_fullscreen_hint()}
        </span>
      )}
    </div>
  );
}

// FR-30/31/33 remote canvas tile: a placeholder (Watch, FR-30) until the viewer opts in, then the live
// video (letterboxed 16:9, muted — audio flows through the gain node) with an unwatch button and,
// when the stream carries audio, an independent volume slider. A single left-click on a watched tile
// escalates the layout (grid → main → fullscreen ↔ main; the Canvas decides, FR-33) — a pure layout
// toggle: the pull is pinned to the high simulcast layer from the start, so focus/fullscreen never
// changes quality. Overlay controls stop propagation.
function RemoteTile({
  stream,
  onToggleFocus,
  fullscreen,
  onToggleFullscreen,
}: {
  stream: StreamInfo;
  onToggleFocus: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { state, mediaStream, watch, unwatch } = useWatch(stream);
  const watching = state !== "idle";
  const streamKey = `${stream.userId}:${stream.kind}`;

  return (
    <div
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
          mediaStream={mediaStream}
          onUnwatch={unwatch}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
      ) : (
        <Placeholder stream={stream} onWatch={watch} />
      )}
    </div>
  );
}

function WatchingView({
  stream,
  streamKey,
  mediaStream,
  onUnwatch,
  fullscreen,
  onToggleFullscreen,
}: {
  stream: StreamInfo;
  streamKey: string;
  mediaStream: MediaStream | null;
  onUnwatch: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.srcObject = mediaStream;
  }, [mediaStream]);
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
      <TileOverlay fullscreen={fullscreen}>
        <FullscreenButton
          trackName={stream.trackName}
          fullscreen={fullscreen}
          onToggle={onToggleFullscreen}
        />
        {/* Unwatch is hidden in fullscreen so unwatching can't strand the placeholder full-window —
            exit fullscreen first, then unwatch from the grid. */}
        {!fullscreen && (
          <Button
            size="xs"
            variant="secondary"
            data-testid={`stream-unwatch-${stream.trackName}`}
            onClick={onUnwatch}
          >
            {m.streams_unwatch()}
          </Button>
        )}
        {stream.hasAudio && <StreamVolume streamKey={streamKey} />}
      </TileOverlay>
    </>
  );
}

function StreamVolume({ streamKey }: { streamKey: string }) {
  const gain = useSettingsStore((s) => s.volumes.streams[streamKey] ?? 1);
  const percent = Math.round(gain * 100);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" title={m.streams_volume()}>
      <Slider
        value={[percent]}
        min={0}
        max={200}
        step={5}
        data-testid={`stream-volume-${streamKey}`}
        onValueChange={(value) => {
          const next = Array.isArray(value) ? (value[0] ?? 0) : value;
          setStreamVolume(streamKey, next / 100);
        }}
      />
      <span className="w-9 shrink-0 text-right text-xs text-white/80 tabular-nums">{percent}%</span>
    </div>
  );
}

function Placeholder({ stream, onWatch }: { stream: StreamInfo; onWatch: () => void }) {
  const serverId = useServersStore((s) => s.activeServerId) ?? "";
  const member = useStore(roomStore(serverId), (s) =>
    s.members.find((mm) => mm.userId === stream.userId),
  );
  const name = member?.displayName ?? stream.userId.slice(0, 8);
  const color = member?.color ?? "#888888";
  const [avatarFailed, setAvatarFailed] = useState(false);
  const KindIcon = stream.kind === "screen" ? MonitorIcon : VideoIcon;
  return (
    <div className="flex flex-col items-center gap-3 p-4 text-center">
      <span className="relative">
        {avatarFailed || !member ? (
          <span
            data-testid={`stream-avatar-${stream.trackName}`}
            className="flex size-14 items-center justify-center rounded-full text-lg font-medium text-white"
            style={{ backgroundColor: color }}
          >
            {name.charAt(0)}
          </span>
        ) : (
          <img
            src={`/api/media/avatars/${stream.userId}.webp`}
            alt={name}
            onError={() => setAvatarFailed(true)}
            className="size-14 rounded-full bg-muted object-cover"
          />
        )}
        <span className="absolute -right-1 -bottom-1 rounded-full bg-background p-1 text-foreground">
          <KindIcon data-testid={`stream-kind-${stream.trackName}`} className="size-3.5" />
        </span>
      </span>
      <span className="text-sm font-medium" style={{ color }}>
        {name}
      </span>
      <Button size="sm" data-testid={`stream-watch-${stream.trackName}`} onClick={onWatch}>
        {m.streams_watch()}
      </Button>
    </div>
  );
}
