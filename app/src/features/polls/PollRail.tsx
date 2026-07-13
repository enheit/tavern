import {
  CheckCircle2Icon,
  BarChart3Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CoinsIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { toast } from "sonner";
import type { Poll } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errorMessage";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { PollDialog } from "./PollDialog";

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function remaining(deadline: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, "0")}` : `${rest}s`;
}

function pollStatus(poll: Poll, now: number): string {
  if (poll.status === "open") return m.polls_ends_in({ time: remaining(poll.closesAt, now) });
  if (poll.status === "locked" && poll.lockedAt !== null) {
    return m.polls_resolve_by({ time: remaining(poll.lockedAt + 24 * 60 * 60_000, now) });
  }
  if (poll.status === "resolved_pending" && poll.resultVisibleUntil !== null) {
    return m.polls_disappears_in({ time: remaining(poll.resultVisibleUntil, now) });
  }
  return m.polls_locked();
}

export function PollRail({ serverId }: { serverId: string }) {
  const store = roomStore(serverId);
  const polls = useStore(store, (state) => state.polls);
  const pollError = useStore(store, (state) => state.pollError);
  const clearPollError = useStore(store, (state) => state.clearPollError);
  const serverMeta = useStore(store, (state) => state.serverMeta);
  const selfId = useSessionStore((state) => state.profile?.userId ?? null);
  const now = useNow();
  const visible = useMemo(
    () =>
      polls
        .filter(
          (poll) =>
            poll.status === "open" ||
            poll.status === "locked" ||
            (poll.status === "resolved_pending" &&
              poll.resultVisibleUntil !== null &&
              poll.resultVisibleUntil > now),
        )
        .toSorted((a, b) => {
          if (a.status === "resolved_pending" && b.status !== "resolved_pending") return -1;
          if (b.status === "resolved_pending" && a.status !== "resolved_pending") return 1;
          return a.createdAt - b.createdAt;
        }),
    [polls, now],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const latestResolution = useRef(0);

  useEffect(() => {
    if (pollError === null) return;
    toast.error(errorMessage(pollError));
    clearPollError();
  }, [pollError, clearPollError]);

  useEffect(() => {
    const resolved = visible
      .filter((poll) => poll.status === "resolved_pending")
      .toSorted((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))[0];
    if (resolved !== undefined && (resolved.resolvedAt ?? 0) > latestResolution.current) {
      latestResolution.current = resolved.resolvedAt ?? 0;
      setSelectedId(resolved.id);
      return;
    }
    if (!visible.some((poll) => poll.id === selectedId)) setSelectedId(visible[0]?.id ?? null);
  }, [selectedId, visible]);

  if (visible.length === 0) return null;
  const index = Math.max(
    0,
    visible.findIndex((poll) => poll.id === selectedId),
  );
  const poll = visible[index] ?? visible[0];
  if (poll === undefined) return null;
  const canManage = selfId === poll.creatorId || selfId === serverMeta?.adminUserId;
  const actionLabel = canManage ? m.polls_manage() : m.polls_predict();
  const winning = poll.outcomes.find((outcome) => outcome.id === poll.winningOutcomeId);
  const bidOutcome = poll.outcomes.find((outcome) => outcome.id === poll.myBid?.outcomeId);
  const resultNet = poll.myBid === null ? null : poll.myBid.payout - poll.myBid.stake;
  const summaryLabel = `${visible.length} running poll${visible.length === 1 ? "" : "s"}`;

  function move(delta: number): void {
    const next = (index + delta + visible.length) % visible.length;
    setSelectedId(visible[next]?.id ?? selectedId);
  }
  function collapse(): void {
    setDialogOpen(false);
    setExpanded(false);
  }

  return (
    <div
      data-testid="poll-rail"
      className="pointer-events-none absolute inset-x-2 top-2 z-10 flex justify-center"
    >
      {!expanded ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${summaryLabel}. Expand poll details`}
          onClick={() => setExpanded(true)}
          className="pointer-events-auto h-8 w-fit max-w-full justify-start rounded-full border-border/70 bg-background/90 px-3 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur hover:bg-muted/70 hover:text-foreground"
        >
          <span className="flex min-w-0 items-center gap-2">
            <BarChart3Icon className="size-3.5 shrink-0 text-violet-500" />
            <span className="truncate">{summaryLabel}</span>
          </span>
        </Button>
      ) : (
        <article
          data-testid={`poll-card-${poll.id}`}
          className={cn(
            "pointer-events-auto relative w-full max-w-[40rem] overflow-hidden rounded-lg border bg-background/95 p-2.5 shadow-lg backdrop-blur",
            poll.status === "resolved_pending" && "animate-poll-result border-violet-500/60",
            poll.status === "resolved_pending" &&
              poll.resultVisibleUntil !== null &&
              poll.resultVisibleUntil - now <= 600 &&
              "animate-poll-exit",
          )}
        >
          <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Collapse poll details. ${summaryLabel}`}
              onClick={collapse}
              className="h-7 rounded-full border border-border/70 bg-background/90 px-3 text-xs font-medium text-muted-foreground shadow-none hover:bg-muted/70 hover:text-foreground"
            >
              <ChevronUpIcon className="mr-1 size-3.5" />
              {summaryLabel}
            </Button>
          </div>
          <h3 className="mt-1 line-clamp-2 text-sm leading-snug font-semibold">{poll.question}</h3>
          <div className="mt-2 grid gap-1">
            {poll.outcomes.slice(0, 3).map((outcome) => {
              const width =
                poll.totalPool === 0 ? 0 : Math.round((outcome.totalPoints / poll.totalPool) * 100);
              const isWinner = outcome.id === poll.winningOutcomeId;
              return (
                <div
                  key={outcome.id}
                  className={cn(
                    "relative overflow-hidden rounded bg-muted px-2 py-1 text-xs",
                    poll.status === "resolved_pending" && !isWinner && "opacity-45",
                  )}
                >
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 bg-violet-500/15 transition-[width] duration-500",
                      isWinner && "bg-emerald-500/25",
                    )}
                    style={{ width: `${width}%` }}
                  />
                  <div className="relative flex items-center justify-between gap-2">
                    <span className="truncate">
                      {isWinner ? (
                        <CheckCircle2Icon className="mr-1 inline size-3 text-emerald-500" />
                      ) : null}
                      {outcome.title}
                    </span>
                    <span className="tabular-nums">{outcome.totalPoints}</span>
                  </div>
                </div>
              );
            })}
            {poll.outcomes.length > 3 ? (
              <span className="text-[11px] text-muted-foreground">+{poll.outcomes.length - 3}</span>
            ) : null}
          </div>
          <div className="mt-2 grid gap-1">
            <div className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[11px] text-muted-foreground">
                <CoinsIcon className="size-3 text-violet-400" />
                {m.polls_pool({ points: poll.totalPool })}
              </span>
              {(poll.status === "open" && poll.myBid === null) || canManage ? (
                <Button
                  size="xs"
                  data-testid={`poll-action-${poll.id}`}
                  onClick={() => setDialogOpen(true)}
                >
                  {actionLabel}
                </Button>
              ) : null}
            </div>
          </div>
          {poll.myBid !== null && bidOutcome !== undefined && poll.status !== "resolved_pending" ? (
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {m.polls_your_bid({ points: poll.myBid.stake, outcome: bidOutcome.title })}
            </p>
          ) : null}
          {poll.status === "resolved_pending" && winning !== undefined && resultNet !== null ? (
            <p
              className={cn(
                "mt-1 text-xs font-semibold",
                resultNet >= 0 ? "text-emerald-500" : "text-destructive",
              )}
            >
              {resultNet >= 0
                ? m.polls_you_won({ points: resultNet })
                : m.polls_you_lost({ points: Math.abs(resultNet) })}
            </p>
          ) : null}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{pollStatus(poll, now)}</span>
            {visible.length > 1 ? (
              <div className="flex items-center gap-1">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={m.polls_previous()}
                  onClick={() => move(-1)}
                >
                  <ChevronLeftIcon />
                </Button>
                <span className="tabular-nums">
                  {index + 1}/{visible.length}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={m.polls_next()}
                  onClick={() => move(1)}
                >
                  <ChevronRightIcon />
                </Button>
              </div>
            ) : null}
          </div>
        </article>
      )}
      {!expanded ? null : (
        <PollDialog
          serverId={serverId}
          poll={poll}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </div>
  );
}
