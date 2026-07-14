import { computeLayout } from "@tavern/shared";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import type { VoiceLoungeMember } from "@/features/home/VoiceLounge";
import { captureStreamScreenshot } from "@/features/screenshots/captureScreenshot";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { useMediaStore } from "@/stores/media";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { StreamTile } from "./StreamTile";
import { isWatchingTrack } from "./useWatch";
import { useWebcamStore } from "./useWebcam";
import { VoiceAvatarTile } from "./VoiceAvatarTile";

type CanvasParticipant =
  | { kind: "stream"; key: string; trackName: string }
  | { kind: "voice"; key: string; member: VoiceLoungeMember };

// The `f` fullscreen shortcut must not fire while the user is typing (chat box, inputs) — ignore the key
// when it originates from an editable element.
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

// Space (screenshot) must also yield to focused interactive controls — Space is a button/link activation
// key, so a pressed Watch/unwatch/fullscreen button keeps its default behaviour instead of capturing.
function isInteractiveTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return isTypingTarget(el) || el.closest('button, a, [role="button"]') !== null;
}

// FR-32 canvas auto-layout. Tiles are laid out per §App-C via computeLayout (unit-locked table),
// re-measured with a ResizeObserver. FR-33 focus mode is a SEPARATE flex-column layout (the focused
// tile fills the top; every other stream sits below it as a thumbnail in a horizontal filmstrip —
// click a thumbnail to promote it to main) — never a computeLayout case. Tile order is trackName
// ascending (stable). WorkspaceTabs owns navigation and tells the canvas whether its shortcuts are
// active; the canvas itself owns only stream presentation.
export function Canvas({ serverId, active }: { serverId: string; active: boolean }) {
  const store = roomStore(serverId);
  const members = useStore(store, (s) => s.members);
  const voice = useStore(store, (s) => s.voice);
  const streams = useStore(store, (s) => s.streams);
  const focusedTrackName = useStore(store, (s) => s.focusedTrackName);
  const setFocused = useStore(store, (s) => s.setFocusedTrackName);
  const focusedVoiceUserId = useStore(store, (s) => s.focusedVoiceUserId);
  const setFocusedVoice = useStore(store, (s) => s.setFocusedVoiceUserId);
  const fullscreenTrackName = useStore(store, (s) => s.fullscreenTrackName);
  const setFullscreen = useStore(store, (s) => s.setFullscreenTrackName);
  const fullscreenVoiceUserId = useStore(store, (s) => s.fullscreenVoiceUserId);
  const setFullscreenVoice = useStore(store, (s) => s.setFullscreenVoiceUserId);
  const selfUserId = useSessionStore((s) => s.profile?.userId);

  // FR-29 self-preview: the live LOCAL stream is rendered directly on the sharer's own tile (never
  // pulled from the SFU). Matched by trackName so only the sharer's own tile gets it — BOTH the webcam
  // (`cam:{userId}`, from useWebcamStore) and the screen share (from stores/media.ts). Without the
  // screen branch a self screen-share tile got a null stream and rendered black.
  const camStream = useWebcamStore((s) => s.stream);
  const camTrackName = useWebcamStore((s) => s.trackName);
  const shareStream = useMediaStore((s) => s.shareStream);
  const shareTrackName = useMediaStore((s) => s.shareTrackName);
  const selfStreamFor = (trackName: string): MediaStream | null => {
    if (trackName === camTrackName) return camStream;
    if (trackName === shareTrackName) return shareStream;
    return null;
  };

  // Guards against a second capture starting while one round-trip (draw → webp → upload) is still in
  // flight, so a quick double-tap of Space uploads once rather than racing two identical stills.
  const capturingRef = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    // Feature-detect ResizeObserver (absent in jsdom); the fixed-row layouts (n≥3) don't need
    // measurement, so the canvas still lays out — it just won't re-measure on resize there.
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard: Esc + `f`.
  // - Esc exits, fullscreen first (theater) then focus (FR-33) — a single Esc collapses the top layer
  //   without also dropping focus underneath.
  // - `f` toggles theater fullscreen. Already fullscreen → back to the previous layout. A focused voice
  //   avatar remains the target; otherwise use the focused stream, or the first stream in trackName order
  //   that is actually showing video (self or a watched remote). Ignored while typing, with modifiers,
  //   and on auto-repeat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (fullscreenVoiceUserId !== null) setFullscreenVoice(null);
        else if (fullscreenTrackName !== null) setFullscreen(null);
        else if (focusedTrackName !== null) setFocused(null);
        else if (focusedVoiceUserId !== null) setFocusedVoice(null);
        return;
      }
      if (!active) return;
      if (e.key === "f" || e.key === "F") {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
        e.preventDefault();
        if (fullscreenVoiceUserId !== null) {
          setFullscreenVoice(null);
          return;
        }
        if (fullscreenTrackName !== null) {
          setFullscreen(null);
          return;
        }
        if (focusedVoiceUserId !== null) {
          setFullscreenVoice(focusedVoiceUserId);
          return;
        }
        const ordered = [...streams].toSorted((a, b) => a.trackName.localeCompare(b.trackName));
        const focused =
          focusedTrackName === null
            ? undefined
            : ordered.find((s) => s.trackName === focusedTrackName);
        const target =
          focused ?? ordered.find((s) => s.userId === selfUserId || isWatchingTrack(s.trackName));
        if (target) setFullscreen(target.trackName);
        return;
      }
      // Space: screenshot the single focused stream (fullscreen takes priority, else the focused tile).
      // With NO stream focused, nothing is captured — a hint toast explains why (per the spec: "if no
      // stream focused, then no-one makes a screenshot").
      if (e.key === " " || e.code === "Space") {
        if (
          e.repeat ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          e.shiftKey ||
          isInteractiveTarget(e.target)
        )
          return;
        const target = fullscreenTrackName ?? focusedTrackName;
        if (target === null) {
          toast.message(m.screenshots_focus_hint());
          return;
        }
        e.preventDefault();
        if (capturingRef.current) return;
        capturingRef.current = true;
        void captureStreamScreenshot(serverId, target).finally(() => {
          capturingRef.current = false;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    streams,
    focusedTrackName,
    focusedVoiceUserId,
    fullscreenTrackName,
    fullscreenVoiceUserId,
    selfUserId,
    serverId,
    setFullscreen,
    setFocused,
    setFocusedVoice,
    setFullscreenVoice,
    active,
  ]);

  const sorted = [...streams].toSorted((a, b) => a.trackName.localeCompare(b.trackName));
  const webcamUserIds = new Set(
    sorted.filter((stream) => stream.kind === "webcam").map((stream) => stream.userId),
  );
  const voiceMembers = voice.members
    .flatMap((voiceMember) => {
      if (webcamUserIds.has(voiceMember.userId)) return [];
      const profile = members.find((member) => member.userId === voiceMember.userId);
      return profile === undefined ? [] : [{ profile, voice: voiceMember }];
    })
    .toSorted((a, b) =>
      a.profile.displayName.localeCompare(b.profile.displayName, undefined, {
        sensitivity: "base",
      }),
    );
  const participants: CanvasParticipant[] = [
    ...sorted.map((stream) => ({
      kind: "stream" as const,
      key: `stream:${stream.trackName}`,
      trackName: stream.trackName,
    })),
    ...voiceMembers.map((member) => ({
      kind: "voice" as const,
      key: `voice:${member.profile.userId}`,
      member,
    })),
  ];
  const focusedStream =
    focusedTrackName === null ? undefined : sorted.find((s) => s.trackName === focusedTrackName);
  const focusedVoiceMember =
    focusedVoiceUserId === null
      ? undefined
      : voiceMembers.find((member) => member.profile.userId === focusedVoiceUserId);
  const fullscreenStream =
    fullscreenTrackName === null
      ? undefined
      : sorted.find((stream) => stream.trackName === fullscreenTrackName);
  const fullscreenVoiceMember =
    fullscreenVoiceUserId === null
      ? undefined
      : voiceMembers.find((member) => member.profile.userId === fullscreenVoiceUserId);
  const focusedParticipantKey =
    focusedVoiceMember !== undefined
      ? `voice:${focusedVoiceMember.profile.userId}`
      : focusedStream === undefined
        ? null
        : `stream:${focusedStream.trackName}`;

  // A tile owns live browser media state, so changing its visual placement must never change its
  // React identity. Every stream is therefore rendered exactly once as a stable, keyed child of the
  // canvas. Grid/focus/theater modes only change CSS placement. In particular, the local <video>
  // element survives the full-size cycle instead of remounting with an empty srcObject and replaying
  // preview/placeholder UI while the browser starts it again.
  const fullscreen = fullscreenStream !== undefined || fullscreenVoiceMember !== undefined;
  const fullscreenParticipantKey =
    fullscreenVoiceMember !== undefined
      ? `voice:${fullscreenVoiceMember.profile.userId}`
      : fullscreenStream === undefined
        ? null
        : `stream:${fullscreenStream.trackName}`;
  const focused = !fullscreen && focusedParticipantKey !== null;
  const gridRows =
    !fullscreen && !focused ? computeLayout(participants.length, size.w, size.h).rows : [];
  const placements = new Map<string, { row: number; columns: number }>();
  let placementIndex = 0;
  for (const [row, columns] of gridRows.entries()) {
    for (const participant of participants.slice(placementIndex, placementIndex + columns)) {
      placements.set(participant.key, { row, columns });
    }
    placementIndex += columns;
  }
  const thumbnails = focused
    ? participants.filter((participant) => participant.key !== focusedParticipantKey)
    : [];
  const thumbnailIndex = new Map(
    thumbnails.map((participant, index) => [participant.key, index] as const),
  );
  const canvasStyle: CSSProperties = fullscreen
    ? { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "minmax(0, 1fr)" }
    : focused
      ? {
          gridTemplateColumns: `repeat(${Math.max(1, thumbnails.length)}, minmax(0, 1fr))`,
          gridTemplateRows: thumbnails.length === 0 ? "minmax(0, 1fr)" : "minmax(0, 1fr) 9rem",
        }
      : {
          gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
          gridTemplateRows: `repeat(${Math.max(1, gridRows.length)}, minmax(0, 1fr))`,
        };
  const layoutFor = (
    participantKey: string,
    isFullscreenTarget: boolean,
  ): {
    focusedTile: boolean;
    placement: { row: number; columns: number } | undefined;
    slotStyle: CSSProperties;
  } => {
    const placement = placements.get(participantKey);
    const focusedTile = focused && participantKey === focusedParticipantKey;
    if (fullscreen) {
      return {
        focusedTile,
        placement,
        slotStyle: isFullscreenTarget
          ? { gridColumn: "1", gridRow: "1" }
          : { display: "none", gridColumn: "1", gridRow: "1" },
      };
    }
    if (focused) {
      return {
        focusedTile,
        placement,
        slotStyle: focusedTile
          ? { gridColumn: "1 / -1", gridRow: "1" }
          : { gridColumn: (thumbnailIndex.get(participantKey) ?? 0) + 1, gridRow: "2" },
      };
    }
    const columns = placement?.columns ?? 1;
    return {
      focusedTile,
      placement,
      slotStyle: {
        gridColumn: `span ${12 / columns} / span ${12 / columns}`,
        gridRow: (placement?.row ?? 0) + 1,
      },
    };
  };

  return (
    <div
      ref={ref}
      data-testid="canvas"
      data-focused={focused ? "true" : undefined}
      data-fullscreen={fullscreen ? "true" : undefined}
      className={cn(
        "grid h-full min-h-0 w-full gap-2 p-2",
        fullscreen && "fixed inset-0 z-50 bg-black p-0",
      )}
      style={canvasStyle}
    >
      {focused && thumbnails.length > 0 && (
        <div
          data-testid="focus-strip"
          aria-hidden={true}
          className="pointer-events-none min-h-0 min-w-0"
          style={{ gridColumn: "1 / -1", gridRow: 2 }}
        />
      )}
      {sorted.map((stream) => {
        const participantKey = `stream:${stream.trackName}`;
        const isFullscreen = fullscreen && stream.trackName === fullscreenStream?.trackName;
        const { focusedTile, placement, slotStyle } = layoutFor(participantKey, isFullscreen);
        return (
          <div
            key={stream.trackName}
            data-testid={`stream-slot-${stream.trackName}`}
            data-layout-row={!fullscreen && !focused ? placement?.row : undefined}
            data-focused-tile={focusedTile ? "true" : undefined}
            data-focus-thumbnail={focused && !focusedTile ? "true" : undefined}
            data-fullscreen-tile={isFullscreen ? "true" : undefined}
            className={cn(
              "min-h-0 min-w-0",
              focused && !focusedTile && "aspect-video h-full max-w-full justify-self-center",
            )}
            style={slotStyle}
          >
            <StreamTile
              stream={stream}
              selfStream={selfStreamFor(stream.trackName)}
              fullscreen={isFullscreen}
              compact={focused && !focusedTile}
              showStats={focusedTile || isFullscreen}
              onToggleFocus={() => {
                if (isFullscreen) {
                  setFocused(stream.trackName);
                  setFullscreen(null);
                } else if (focused) {
                  if (focusedTile) setFullscreen(stream.trackName);
                  else setFocused(stream.trackName);
                } else {
                  setFocused(focusedTrackName === stream.trackName ? null : stream.trackName);
                }
              }}
              onToggleFullscreen={() => setFullscreen(isFullscreen ? null : stream.trackName)}
            />
          </div>
        );
      })}
      {voiceMembers.map((member) => {
        const participantKey = `voice:${member.profile.userId}`;
        const isFullscreen = fullscreenParticipantKey === participantKey;
        const { focusedTile, placement, slotStyle } = layoutFor(participantKey, isFullscreen);
        return (
          <div
            key={member.profile.userId}
            data-testid={`voice-avatar-slot-${member.profile.userId}`}
            data-layout-row={!fullscreen && !focused ? placement?.row : undefined}
            data-focused-tile={focusedTile ? "true" : undefined}
            data-focus-thumbnail={focused && !focusedTile ? "true" : undefined}
            data-fullscreen-tile={isFullscreen ? "true" : undefined}
            className={cn(
              "min-h-0 min-w-0",
              focused && !focusedTile && "aspect-video h-full max-w-full justify-self-center",
            )}
            style={slotStyle}
          >
            <VoiceAvatarTile
              active={active && (!fullscreen || isFullscreen)}
              compact={focused && !focusedTile}
              member={member}
              serverId={serverId}
              onFocus={() => {
                if (isFullscreen) {
                  setFullscreenVoice(null);
                } else if (focused && focusedTile) {
                  setFullscreenVoice(member.profile.userId);
                } else {
                  setFocusedVoice(member.profile.userId);
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
