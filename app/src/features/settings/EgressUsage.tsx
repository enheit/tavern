import type { CostStatus } from "@tavern/shared";
import { LIMITS } from "@tavern/shared";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";

export function EgressUsage({ cost }: { cost: CostStatus | null }) {
  if (cost === null) return null;
  const pct = Math.min(100, (cost.usedGB / cost.capGB) * 100);
  const warnPct = Math.min(100, (LIMITS.egressWarnGB / cost.capGB) * 100);
  const warned = cost.usedGB >= LIMITS.egressWarnGB;
  return (
    <section data-testid="settings-egress" className="flex flex-col gap-2 border-t pt-4">
      <h3 className="text-sm font-medium">{m.stats_egress_title()}</h3>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted">
        <div
          data-testid="settings-egress-bar"
          className={cn(
            "h-full rounded-full",
            cost.blocked ? "bg-destructive" : warned ? "bg-amber-500" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-y-0 w-px bg-border" style={{ left: `${warnPct}%` }} />
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span data-testid="settings-egress-used" className="text-sm tabular-nums">
          {m.stats_egress_used({ used: cost.usedGB.toFixed(1), cap: cost.capGB })}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {m.stats_egress_warn({ warn: LIMITS.egressWarnGB })}
        </span>
      </div>
      {cost.blocked ? (
        <p data-testid="settings-egress-blocked" className="text-xs text-destructive">
          {m.stats_egress_blocked()}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{m.stats_egress_note()}</p>
    </section>
  );
}
