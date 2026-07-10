import { useEffect, useState } from "react";

// FR-24 voice session timer. Renders from `voice.state.sessionStartedAt` (shared by ALL members,
// including those not in voice). Format: `mm:ss` under 1 h, else `h:mm:ss`. A local 1 s interval
// re-renders the elapsed value; the chip is hidden while no session is active.
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function TimerChip({ sessionStartedAt }: { sessionStartedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (sessionStartedAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sessionStartedAt]);

  if (sessionStartedAt === null) return null;
  return (
    <span
      data-testid="voice-timer"
      className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground tabular-nums"
    >
      {formatElapsed(now - sessionStartedAt)}
    </span>
  );
}
