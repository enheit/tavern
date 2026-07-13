import { CoinsIcon } from "lucide-react";
import { useStore } from "zustand";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";

export function PointsButton({ serverId }: { serverId: string }) {
  const points = useStore(roomStore(serverId), (state) => state.points);
  return (
    <Popover>
      <PopoverTrigger
        data-testid="points-trigger"
        aria-label={m.points_open_details()}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <CoinsIcon className="size-4 text-violet-400" />
        <span data-testid="points-balance" className="font-semibold text-foreground tabular-nums">
          {points.balance.toLocaleString()}
        </span>
      </PopoverTrigger>
      <PopoverContent data-testid="points-details" align="start" side="top" className="w-72">
        <div className="flex items-center justify-between">
          <span className="font-medium">{m.points_title()}</span>
          <span className="font-semibold tabular-nums">{points.balance.toLocaleString()}</span>
        </div>
        {points.currentRatePerMinute > 0 ? (
          <p className="text-xs font-medium text-violet-400 tabular-nums">
            {m.points_rate({ rate: points.currentRatePerMinute })}
          </p>
        ) : null}
        <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-2 text-xs">
          {points.pendingPollWinnings > 0 ? (
            <>
              <span>{m.points_pending_poll()}</span>
              <span
                data-testid="points-pending-poll"
                className="font-medium text-violet-400 tabular-nums"
              >
                +{points.pendingPollWinnings}
              </span>
            </>
          ) : null}
          <span>{m.points_conversation()}</span>
          <span className="tabular-nums">{points.today.conversation}</span>
          <span>{m.points_streaming()}</span>
          <span className="tabular-nums">{points.today.streaming}</span>
          <span>{m.points_watching()}</span>
          <span className="tabular-nums">{points.today.watching}</span>
          <span className="font-medium">{m.points_today()}</span>
          <span data-testid="points-today" className="font-medium tabular-nums">
            {points.today.total}
            {points.config.dailyCap === null ? "" : ` / ${points.config.dailyCap}`}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
