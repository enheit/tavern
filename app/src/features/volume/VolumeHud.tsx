import { Volume1Icon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { cn } from "@/lib/utils";
import { volumeHudStore } from "./hudStore";

// Center-screen volume feedback (FR-20/31). Mounted once in AppShell; subscribes to the shared HUD
// store. Appears the instant a scroll notch (or middle-click reset) lands on a voice nickname or a
// watched stream tile, then fades out ~1s after the last change. Pointer-events-none so it never eats
// clicks, and z above the theater-fullscreen canvas (z-50) so it shows even over a maximized stream.
const FADE_MS = 1000;

export function VolumeHud() {
  const current = useStore(volumeHudStore, (s) => s.current);
  const [visible, setVisible] = useState(false);
  const seq = current?.seq;
  // Baseline the seq we mounted at so a remount (server switch / locale re-key) doesn't replay the last,
  // stale HUD for a second — only a seq that advances AFTER mount is a real, fresh scroll to show.
  const shownSeq = useRef(seq);

  useEffect(() => {
    if (seq === undefined || seq === shownSeq.current) return;
    shownSeq.current = seq;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), FADE_MS);
    return () => clearTimeout(t);
  }, [seq]);

  if (!current) return null;
  const { label, percent, color } = current;
  // Icon telegraphs the level at a glance: silenced → boosted.
  const Icon = percent === 0 ? VolumeXIcon : percent <= 100 ? Volume1Icon : Volume2Icon;
  const accent = percent === 0 ? "#ef4444" : (color ?? "#8b5cf6");
  // The 0–200% track: unity (100%) sits at the midpoint, so a full bar = the 200% ceiling.
  const fill = Math.min(100, (percent / 200) * 100);

  return (
    <div
      data-testid="volume-hud"
      aria-hidden
      className={cn(
        "pointer-events-none fixed inset-0 z-[100] flex items-center justify-center transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="flex w-64 flex-col items-center gap-3 rounded-2xl bg-black/80 px-6 py-5 text-white shadow-2xl backdrop-blur-sm">
        <div className="flex items-center gap-2" style={{ color: accent }}>
          <Icon className="size-6" />
          <span className="max-w-40 truncate text-sm font-medium text-white/90" title={label}>
            {label}
          </span>
        </div>
        <div className="text-4xl font-semibold tabular-nums">{percent}%</div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/15">
          <div
            className="h-full rounded-full transition-[width] duration-100"
            style={{ width: `${fill}%`, backgroundColor: accent }}
          />
          {/* Unity (100%) tick — the reference the boost/cut is measured against. */}
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/40" />
        </div>
      </div>
    </div>
  );
}
