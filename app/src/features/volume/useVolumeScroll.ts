import { useEffect, useRef, useState } from "react";
import { pushVolumeHud } from "./hudStore";

// Volume-level bounds + wheel granularity. Default is 1.0 = 100%; the ceiling is 200%.
// One wheel notch = ±5%, matching the old slider's `step={5}` so the two feel identical.
const MIN_LEVEL = 0;
const MAX_LEVEL = 2;
const STEP = 0.05;
// How long the inline percent stays up after the last scroll notch before it fades away.
const INLINE_MS = 1400;

function clampLevel(level: number): number {
  // Round to whole percents so accumulated float steps never drift (…0.15000000000000002).
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level * 100) / 100));
}

export interface VolumeScrollOptions {
  // When false the gesture is inert (self chip, un-watched / audioless stream) — no wheel capture,
  // no reset, no HUD.
  enabled: boolean;
  // Fresh read of the target's current displayed level (0..2). Read lazily inside the handler so the
  // value is never a stale closure from an earlier render.
  read: () => number;
  // Persist + apply the new level (0..2) — e.g. voiceController.setUserVolume / setStreamVolume.
  write: (level: number) => void;
  // Fresh HUD metadata for the target (label/color can change as the room store updates).
  meta: () => { key: string; label: string; color?: string };
}

// Wheel-to-adjust a single audio target's local volume, with a middle-click "reset to 0" and a
// transient inline percent (returned as `percent`, null while idle). Attaches native, NON-passive
// wheel/auxclick/mousedown listeners via the returned ref: React's synthetic onWheel is passive, so
// `preventDefault()` there is a no-op — we must go native to stop the list/page from scrolling while
// the pointer is over the target. deltaX-dominant scroll (trackpad sideways / Shift+wheel) is left
// alone so a horizontal filmstrip still scrolls under the cursor; a plain vertical mouse wheel is
// captured as a volume change (the target owns vertical scroll — the trade for the gesture).
export function useVolumeScroll<T extends HTMLElement>(
  opts: VolumeScrollOptions,
): { ref: React.RefObject<T | null>; percent: number | null } {
  const ref = useRef<T>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest options in a ref so the once-attached native listeners always call fresh callbacks without
  // re-binding on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const flash = (level: number): void => {
      const pct = Math.round(level * 100);
      const o = optsRef.current;
      const meta = o.meta();
      pushVolumeHud({
        key: meta.key,
        label: meta.label,
        percent: pct,
        ...(meta.color !== undefined ? { color: meta.color } : {}),
      });
      setPercent(pct);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setPercent(null), INLINE_MS);
    };

    const onWheel = (e: WheelEvent): void => {
      const o = optsRef.current;
      if (!o.enabled) return;
      // Vertical intent only; sideways scroll passes through to any horizontal scroller beneath.
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      // Scroll up (negative deltaY) = louder. Clamp; still flash at the boundary so the ceiling/floor
      // gives feedback instead of feeling dead.
      const next = clampLevel(o.read() + (e.deltaY < 0 ? STEP : -STEP));
      o.write(next);
      flash(next);
    };

    // Middle-click = reset the target to silence (0%).
    const onAuxClick = (e: MouseEvent): void => {
      const o = optsRef.current;
      if (!o.enabled || e.button !== 1) return;
      e.preventDefault();
      o.write(0);
      flash(0);
    };

    // Suppress the browser's middle-click autoscroll so the reset gesture never opens the scroll puck.
    const onMouseDown = (e: MouseEvent): void => {
      if (optsRef.current.enabled && e.button === 1) e.preventDefault();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("auxclick", onAuxClick);
    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("auxclick", onAuxClick);
      el.removeEventListener("mousedown", onMouseDown);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { ref, percent };
}
