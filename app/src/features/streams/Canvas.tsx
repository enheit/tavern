import type { StreamInfo } from "@tavern/shared";
import { computeLayout } from "@tavern/shared";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import { captureStreamScreenshot } from "@/features/screenshots/captureScreenshot";
import { m } from "@/paraglide/messages.js";
import { useMediaStore } from "@/stores/media";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { StreamTile } from "./StreamTile";
import { isWatchingTrack } from "./useWatch";
import { useWebcamStore } from "./useWebcam";

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
  const streams = useStore(store, (s) => s.streams);
  const focusedTrackName = useStore(store, (s) => s.focusedTrackName);
  const setFocused = useStore(store, (s) => s.setFocusedTrackName);
  const fullscreenTrackName = useStore(store, (s) => s.fullscreenTrackName);
  const setFullscreen = useStore(store, (s) => s.setFullscreenTrackName);
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
  // - `f` toggles theater fullscreen. Already fullscreen → back to the previous layout. Otherwise pick a
  //   target: the focused stream if one is focused ("already selected → increase to fullscreen"), else the
  //   first stream in trackName order that is actually showing video (self or a watched remote) — "if 2
  //   equal, choose the first". Ignored while typing / with modifiers / on auto-repeat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (fullscreenTrackName !== null) setFullscreen(null);
        else if (focusedTrackName !== null) setFocused(null);
        return;
      }
      if (!active) return;
      if (e.key === "f" || e.key === "F") {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
        e.preventDefault();
        if (fullscreenTrackName !== null) {
          setFullscreen(null);
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
    fullscreenTrackName,
    selfUserId,
    serverId,
    setFullscreen,
    setFocused,
    active,
  ]);

  const sorted = [...streams].toSorted((a, b) => a.trackName.localeCompare(b.trackName));
  const focusedStream =
    focusedTrackName === null ? undefined : sorted.find((s) => s.trackName === focusedTrackName);
  const fullscreenStream =
    fullscreenTrackName === null
      ? undefined
      : sorted.find((s) => s.trackName === fullscreenTrackName);

  // Theater fullscreen: a fixed overlay above the whole shell (header/sidebar/chat hidden), rendering
  // the single stream window-filling. It escapes the grid because `position: fixed` is viewport-anchored
  // and no ancestor sets a containing block. The grid/focus tree unmounts, but the tile remounts here in
  // the SAME commit, so the watch pull survives the reparent via the trackName-keyed WatchController
  // registry (no re-pull) — exactly as focus mode reparents. WS + room store stay live underneath, so
  // chat and toast notifications keep flowing. Exit via the tile's minimize button, Esc, or clicking the
  // stream itself — a click drops back to focus (main) mode, seeding focus so the main↔fullscreen click
  // cycle also works when fullscreen was entered via `f` straight from the grid.
  if (fullscreenStream) {
    return (
      <div data-testid="canvas" data-fullscreen="true" className="fixed inset-0 z-50 bg-black">
        <StreamTile
          stream={fullscreenStream}
          fullscreen
          selfStream={selfStreamFor(fullscreenStream.trackName)}
          onToggleFocus={() => {
            setFocused(fullscreenStream.trackName);
            setFullscreen(null);
          }}
          onToggleFullscreen={() => setFullscreen(null)}
        />
      </div>
    );
  }

  const others =
    focusedStream === undefined
      ? []
      : sorted.filter((stream) => stream.trackName !== focusedStream.trackName);
  const cells: StreamInfo[][] = [];
  if (sorted.length > 0 && focusedStream === undefined) {
    const { rows } = computeLayout(sorted.length, size.w, size.h);
    let index = 0;
    for (const count of rows) {
      cells.push(sorted.slice(index, index + count));
      index += count;
    }
  }

  return (
    <div
      ref={ref}
      data-testid="canvas"
      data-focused={focusedStream === undefined ? undefined : "true"}
      className="flex h-full min-h-0 w-full flex-col gap-2 p-2"
    >
      {focusedStream === undefined ? (
        cells.map((rowStreams, rowIndex) => (
          <div
            key={rowStreams[0]?.trackName ?? String(rowIndex)}
            data-testid={`canvas-row-${rowIndex}`}
            className="grid min-h-0 flex-1 gap-2"
            style={{ gridTemplateColumns: `repeat(${rowStreams.length}, minmax(0, 1fr))` }}
          >
            {rowStreams.map((stream) => (
              <StreamTile
                key={stream.trackName}
                stream={stream}
                selfStream={selfStreamFor(stream.trackName)}
                onToggleFocus={() =>
                  setFocused(focusedTrackName === stream.trackName ? null : stream.trackName)
                }
                onToggleFullscreen={() => setFullscreen(stream.trackName)}
              />
            ))}
          </div>
        ))
      ) : (
        <>
          {/* Main stream fills the space above the strip. Clicking it escalates to theater fullscreen
              (same as `f` / the tile's maximize button); clicking the fullscreen stream drops back here. */}
          <div className="min-h-0 min-w-0 flex-1">
            <StreamTile
              stream={focusedStream}
              selfStream={selfStreamFor(focusedStream.trackName)}
              onToggleFocus={() => setFullscreen(focusedStream.trackName)}
              onToggleFullscreen={() => setFullscreen(focusedStream.trackName)}
            />
          </div>
          {others.length > 0 ? (
            <div data-testid="focus-strip" className="flex h-28 shrink-0 gap-2 overflow-x-auto">
              {others.map((stream) => (
                <div key={stream.trackName} className="aspect-video h-full shrink-0">
                  <StreamTile
                    stream={stream}
                    selfStream={selfStreamFor(stream.trackName)}
                    onToggleFocus={() => setFocused(stream.trackName)}
                    onToggleFullscreen={() => setFullscreen(stream.trackName)}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
