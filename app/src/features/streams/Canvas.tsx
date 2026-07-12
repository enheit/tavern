import type { StreamInfo } from "@tavern/shared";
import { computeLayout } from "@tavern/shared";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import { captureStreamScreenshot } from "@/features/screenshots/captureScreenshot";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
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
// ascending (stable). Store-driven: reads the active server's streams + focus.
export function Canvas() {
  const serverId = useServersStore((s) => s.activeServerId);
  if (serverId === null) return <div data-testid="canvas" className="h-full w-full" />;
  return <CanvasInner serverId={serverId} />;
}

function CanvasInner({ serverId }: { serverId: string }) {
  const store = roomStore(serverId);
  const streams = useStore(store, (s) => s.streams);
  const focusedTrackName = useStore(store, (s) => s.focusedTrackName);
  const setFocused = useStore(store, (s) => s.setFocusedTrackName);
  const fullscreenTrackName = useStore(store, (s) => s.fullscreenTrackName);
  const setFullscreen = useStore(store, (s) => s.setFullscreenTrackName);
  const selfUserId = useSessionStore((s) => s.profile?.userId);

  // FR-29 self-preview: the live LOCAL webcam stream is rendered directly on its own `cam:{userId}`
  // tile (never pulled from the SFU). Matched by trackName so only the sharer's own cam tile gets it.
  const camStream = useWebcamStore((s) => s.stream);
  const camTrackName = useWebcamStore((s) => s.trackName);
  const selfStreamFor = (trackName: string): MediaStream | null =>
    trackName === camTrackName ? camStream : null;

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

  if (sorted.length === 0) return <div ref={ref} data-testid="canvas" className="h-full w-full" />;

  if (focusedStream) {
    const others = sorted.filter((s) => s.trackName !== focusedStream.trackName);
    return (
      <div
        ref={ref}
        data-testid="canvas"
        data-focused="true"
        className="flex h-full w-full flex-col gap-2 p-2"
      >
        {/* Main stream fills the space above the strip. Clicking it escalates to theater fullscreen
            (same as `f` / the tile's maximize button); clicking the fullscreen stream drops back here —
            click cycles main ↔ fullscreen. Esc (or a thumbnail click) is the way back to the grid. */}
        <div className="min-h-0 min-w-0 flex-1">
          <StreamTile
            stream={focusedStream}
            selfStream={selfStreamFor(focusedStream.trackName)}
            onToggleFocus={() => setFullscreen(focusedStream.trackName)}
            onToggleFullscreen={() => setFullscreen(focusedStream.trackName)}
          />
        </div>
        {/* Every OTHER stream as a thumbnail in a horizontal filmstrip below the main tile. Clicking a
            thumbnail promotes it to main (FR-33). Tiles stay mounted, so their watch pulls stay live —
            no re-pull, and no re-Watch when returning to the grid. */}
        {others.length > 0 && (
          <div data-testid="focus-strip" className="flex h-28 shrink-0 gap-2 overflow-x-auto">
            {others.map((s) => (
              <div key={s.trackName} className="aspect-video h-full shrink-0">
                <StreamTile
                  stream={s}
                  selfStream={selfStreamFor(s.trackName)}
                  onToggleFocus={() => setFocused(s.trackName)}
                  onToggleFullscreen={() => setFullscreen(s.trackName)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const { rows } = computeLayout(sorted.length, size.w, size.h);
  const cells: StreamInfo[][] = [];
  let idx = 0;
  for (const count of rows) {
    cells.push(sorted.slice(idx, idx + count));
    idx += count;
  }

  return (
    <div ref={ref} data-testid="canvas" className="flex h-full w-full flex-col gap-2 p-2">
      {cells.map((rowStreams, r) => (
        <div
          key={rowStreams[0]?.trackName ?? String(r)}
          data-testid={`canvas-row-${r}`}
          className="grid min-h-0 flex-1 gap-2"
          style={{ gridTemplateColumns: `repeat(${rowStreams.length}, minmax(0, 1fr))` }}
        >
          {rowStreams.map((s) => (
            <StreamTile
              key={s.trackName}
              stream={s}
              selfStream={selfStreamFor(s.trackName)}
              onToggleFocus={() =>
                setFocused(focusedTrackName === s.trackName ? null : s.trackName)
              }
              onToggleFullscreen={() => setFullscreen(s.trackName)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
