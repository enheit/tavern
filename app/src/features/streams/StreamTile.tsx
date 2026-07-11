import type { PresetId, StreamInfo } from "@tavern/shared";
import { PRESET_IDS } from "@tavern/shared";
import { MonitorIcon, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { getVoiceController } from "@/features/voice/voiceController";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { PRESET_ITEMS, isPreset } from "./SharePickerDialog";
import { useScreenShare } from "./useScreenShare";
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
  focused,
  onToggleFocus,
  selfStream,
}: {
  stream: StreamInfo;
  focused: boolean;
  onToggleFocus: () => void;
  selfStream?: MediaStream | null;
}) {
  const selfUserId = useSessionStore((s) => s.profile?.userId);
  if (stream.userId === selfUserId) {
    return <SelfTile stream={stream} selfStream={selfStream ?? null} />;
  }
  return <RemoteTile stream={stream} focused={focused} onToggleFocus={onToggleFocus} />;
}

// FR-29 self-preview: the local webcam (or any own stream) shown muted with a "You" badge. No Watch
// button and no useWatch — the sharer sees their own tile without pulling from the SFU. FR-27: the
// sharer's OWN screen tile also carries the on-the-fly quality dropdown (webcam preset is fixed, so
// it is screen-only).
function SelfTile({ stream, selfStream }: { stream: StreamInfo; selfStream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.srcObject = selfStream;
  }, [selfStream]);
  return (
    <div
      data-testid={`stream-tile-${stream.trackName}`}
      data-self="true"
      className="group relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-lg bg-black/90"
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        data-testid={`stream-self-${stream.trackName}`}
        className="h-full w-full object-contain"
      />
      {stream.kind === "screen" && (
        <OwnPresetControl trackName={stream.trackName} fallback={stream.preset} />
      )}
      <span
        data-testid={`stream-self-badge-${stream.trackName}`}
        className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white"
      >
        {m.streams_self()}
      </span>
    </div>
  );
}

// FR-30/31/33 remote canvas tile: a placeholder (Watch, FR-30) until the viewer opts in, then the live
// video (letterboxed 16:9, muted — audio flows through the gain node) with an unwatch button and,
// when the stream carries audio, an independent volume slider. Double-click toggles focus (FR-33).
function RemoteTile({
  stream,
  focused,
  onToggleFocus,
}: {
  stream: StreamInfo;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const { state, mediaStream, watch, unwatch, setLayer } = useWatch(stream);
  const watching = state !== "idle";
  const streamKey = `${stream.userId}:${stream.kind}`;

  // FR-33: a focused (double-clicked) tile pulls the high simulcast layer; a grid tile the low one.
  useEffect(() => {
    if (state === "watching") setLayer(focused ? "h" : "l");
  }, [focused, state, setLayer]);

  return (
    <div
      data-testid={`stream-tile-${stream.trackName}`}
      data-watching={watching}
      onDoubleClick={watching ? onToggleFocus : undefined}
      className="group relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-lg bg-black/90"
    >
      {watching ? (
        <WatchingView
          stream={stream}
          streamKey={streamKey}
          mediaStream={mediaStream}
          onUnwatch={unwatch}
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
}: {
  stream: StreamInfo;
  streamKey: string;
  mediaStream: MediaStream | null;
  onUnwatch: () => void;
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
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          size="xs"
          variant="secondary"
          data-testid={`stream-unwatch-${stream.trackName}`}
          onClick={onUnwatch}
        >
          {m.streams_unwatch()}
        </Button>
        {stream.hasAudio && <StreamVolume streamKey={streamKey} />}
      </div>
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

// FR-27 on-the-fly preset switch, sharer side: a compact quality dropdown overlaid on the OWN screen
// tile. `useScreenShare().preset` is the live self-share preset (mirrored from stores/media); it falls
// back to the StreamInfo preset before the first switch. Selecting a preset drives setPreset (fps-only
// applyConstraints + encoder re-scale + sends stream.preset) — no restart, no viewer renegotiation.
function OwnPresetControl({ trackName, fallback }: { trackName: string; fallback: PresetId }) {
  const { preset, setPreset } = useScreenShare();
  const value: PresetId = preset ?? fallback;
  return (
    <div
      className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100"
      title={m.streams_preset()}
    >
      <Select
        value={value}
        items={PRESET_ITEMS}
        onValueChange={(next) => {
          if (isPreset(next)) void setPreset(next);
        }}
      >
        <SelectTrigger size="sm" data-testid={`stream-preset-${trackName}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESET_IDS.map((id) => (
            <SelectItem key={id} value={id} data-testid={`stream-preset-option-${id}`}>
              {PRESET_ITEMS[id]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
