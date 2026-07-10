import type { StreamInfo } from "@tavern/shared";
import { computeLayout } from "@tavern/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { StreamTile } from "./StreamTile";

// FR-32 canvas auto-layout. Tiles are laid out per §App-C via computeLayout (unit-locked table),
// re-measured with a ResizeObserver. FR-33 focus mode is a SEPARATE flex layout (focused tile fills,
// the rest collapse into a right strip) — never a computeLayout case. Tile order is trackName
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

  // Esc leaves focus (FR-33) — matches the double-click-again toggle.
  useEffect(() => {
    if (focusedTrackName === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setFocused(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedTrackName, setFocused]);

  const sorted = [...streams].toSorted((a, b) => a.trackName.localeCompare(b.trackName));
  const focusedStream =
    focusedTrackName === null ? undefined : sorted.find((s) => s.trackName === focusedTrackName);

  if (sorted.length === 0) return <div ref={ref} data-testid="canvas" className="h-full w-full" />;

  if (focusedStream) {
    const others = sorted.filter((s) => s.trackName !== focusedStream.trackName);
    return (
      <div
        ref={ref}
        data-testid="canvas"
        data-focused="true"
        className="flex h-full w-full gap-2 p-2"
      >
        <div className="min-h-0 min-w-0 flex-1">
          <StreamTile stream={focusedStream} focused onToggleFocus={() => setFocused(null)} />
        </div>
        {others.length > 0 && (
          <div
            data-testid="focus-strip"
            className="flex w-40 shrink-0 flex-col gap-2 overflow-y-auto"
          >
            {others.map((s) => (
              <div key={s.trackName} className="aspect-video shrink-0">
                <StreamTile
                  stream={s}
                  focused={false}
                  onToggleFocus={() => setFocused(s.trackName)}
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
              focused={false}
              onToggleFocus={() =>
                setFocused(focusedTrackName === s.trackName ? null : s.trackName)
              }
            />
          ))}
        </div>
      ))}
    </div>
  );
}
