import { XIcon } from "lucide-react";
import { useStore } from "zustand";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";

// §8 G5 warn banner (S12.3): a dismissible amber strip across the header, shown once the server
// broadcasts `cost.warning` (700 GB estimated egress this month). Dismissal is per-session (store
// flag, no persistence). Overlays the pinned §7.6 grid (absolute, full width) so the layout rows
// stay untouched.
export function CostBanner({ serverId }: { serverId: string }) {
  const store = roomStore(serverId);
  const warning = useStore(store, (s) => s.costWarning);
  const dismissed = useStore(store, (s) => s.costWarningDismissed);
  const dismiss = useStore(store, (s) => s.dismissCostWarning);

  if (warning === null || dismissed) return null;
  return (
    <div
      data-testid="cost-banner"
      className="absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-amber-500 px-3 py-2 text-sm font-medium text-black"
    >
      <span>
        {m.cost_warning_banner({
          usedGB: String(Math.round(warning.usedGB)),
          capGB: String(Math.round(warning.capGB)),
        })}
      </span>
      <button
        type="button"
        data-testid="cost-banner-dismiss"
        aria-label={m.common_cancel()}
        onClick={dismiss}
        className="rounded p-0.5 hover:bg-amber-600"
      >
        <XIcon className="size-4" />
      </button>
    </div>
  );
}
