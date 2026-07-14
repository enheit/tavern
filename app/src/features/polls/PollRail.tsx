import { ChevronLeftIcon, ChevronRightIcon, CoinsIcon, Settings2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { toast } from "sonner";
import { LIMITS, PollPage, type Poll, type PollParticipantResult } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { apiClient } from "@/lib/apiClient";
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
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds / 60);
  if (hours > 0) {
    const remainingMinutes = Math.floor((seconds % 3_600) / 60);
    return `${hours}h ${remainingMinutes}m`;
  }
  return minutes > 0 ? `${minutes}m` : `${seconds}s`;
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

function OutcomeVotes({
  serverId,
  pollId,
  outcomeId,
  count,
}: {
  serverId: string;
  pollId: string;
  outcomeId: string;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const [participants, setParticipants] = useState<PollParticipantResult[] | null>(null);

  useEffect(() => {
    if (!open || participants !== null) return;
    let cancelled = false;
    void apiClient
      .get(`/api/servers/${serverId}/polls?limit=${LIMITS.historyPageSize}`, PollPage)
      .then((page) => {
        if (cancelled) return;
        const poll = page.polls.find((item) => item.id === pollId);
        setParticipants(
          poll?.participants.filter((participant) => participant.outcomeId === outcomeId) ?? [],
        );
      })
      .catch(() => {
        if (!cancelled) setParticipants([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, outcomeId, participants, pollId, serverId]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="shrink-0 rounded px-1 text-xs text-muted-foreground tabular-nums hover:bg-background/60 hover:text-foreground"
          />
        }
      >
        {count}
      </PopoverTrigger>
      <PopoverContent className="w-56">
        <PopoverHeader>
          <PopoverTitle>{m.polls_participants()}</PopoverTitle>
        </PopoverHeader>
        {participants === null ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : participants.length === 0 ? (
          <p className="text-xs text-muted-foreground">{m.polls_no_bids()}</p>
        ) : (
          <ul className="grid gap-1">
            {participants.map((participant) => (
              <li
                key={participant.userId}
                className="flex items-center justify-between gap-3 rounded bg-muted px-2 py-1.5"
              >
                <span className="min-w-0 truncate">{participant.displayName}</span>
                <span className="shrink-0 text-xs tabular-nums">{participant.stake}</span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function PollRail({ serverId }: { serverId: string }) {
  const store = roomStore(serverId);
  const polls = useStore(store, (state) => state.polls);
  const pollError = useStore(store, (state) => state.pollError);
  const clearPollError = useStore(store, (state) => state.clearPollError);
  const serverMeta = useStore(store, (state) => state.serverMeta);
  const points = useStore(store, (state) => state.points);
  const bidPoll = useStore(store, (state) => state.bidPoll);
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
  const [selectedOutcomeId, setSelectedOutcomeId] = useState<string | null>(null);
  const [stakeInput, setStakeInput] = useState("1");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const latestResolution = useRef(0);
  const stakeInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    setSelectedOutcomeId(null);
    setStakeInput("1");
  }, [selectedId]);

  useEffect(() => {
    if (selectedOutcomeId === null) return;
    stakeInputRef.current?.focus();
  }, [selectedOutcomeId]);

  if (visible.length === 0) return null;
  const index = Math.max(
    0,
    visible.findIndex((poll) => poll.id === selectedId),
  );
  const poll = visible[index] ?? visible[0];
  if (poll === undefined) return null;
  const pollId = poll.id;
  const canManage = selfId === poll.creatorId || selfId === serverMeta?.adminUserId;
  const winning = poll.outcomes.find((outcome) => outcome.id === poll.winningOutcomeId);
  const bidOutcome = poll.outcomes.find((outcome) => outcome.id === poll.myBid?.outcomeId);
  const resultNet = poll.myBid === null ? null : poll.myBid.payout - poll.myBid.stake;
  const votingOpen = poll.status === "open" && poll.closesAt > now;
  const canBid = votingOpen && poll.myBid === null;
  const stake = Number(stakeInput);
  const stakeValid =
    Number.isInteger(stake) && stake >= 1 && stake <= points.balance && stakeInput.length > 0;
  const duration = Math.max(1, poll.closesAt - poll.createdAt);
  const remainingProgress = Math.min(100, Math.max(0, ((poll.closesAt - now) / duration) * 100));
  const resultDuration = Math.max(1, (poll.resultVisibleUntil ?? now) - (poll.resolvedAt ?? now));
  const resultProgress = Math.min(
    100,
    Math.max(0, (((poll.resultVisibleUntil ?? now) - now) / resultDuration) * 100),
  );
  const hasCountdown = poll.status === "open" || poll.status === "resolved_pending";
  const countdownProgress = poll.status === "open" ? remainingProgress : resultProgress;

  function move(delta: number): void {
    const next = (index + delta + visible.length) % visible.length;
    setSelectedId(visible[next]?.id ?? selectedId);
  }
  function submitBid(): void {
    if (!canBid || selectedOutcomeId === null || !stakeValid) return;
    bidPoll(pollId, selectedOutcomeId, stake);
    setSelectedOutcomeId(null);
  }

  return (
    <div
      data-testid="poll-rail"
      className="pointer-events-none absolute inset-x-2 top-2 z-10 flex justify-center"
    >
      <article
        data-testid={`poll-card-${poll.id}`}
        className={cn(
          "pointer-events-auto relative w-full max-w-[40rem] overflow-hidden rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur",
          poll.status === "resolved_pending" && "animate-poll-result",
          poll.status === "resolved_pending" &&
            resultNet !== null &&
            resultNet >= 0 &&
            "border-emerald-500/60",
          poll.status === "resolved_pending" &&
            resultNet !== null &&
            resultNet < 0 &&
            "border-destructive/60",
          poll.status === "resolved_pending" && resultNet === null && "border-violet-500/60",
          poll.status === "resolved_pending" &&
            poll.resultVisibleUntil !== null &&
            poll.resultVisibleUntil - now <= 600 &&
            "animate-poll-exit",
        )}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-sm leading-snug font-semibold">{poll.question}</h3>
          </div>
          {canManage ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid={`poll-settings-${poll.id}`}
              aria-label={m.polls_manage()}
              onClick={() => setSettingsOpen(true)}
              className="-mt-1 -mr-1 shrink-0 text-muted-foreground"
            >
              <Settings2Icon className="size-4" />
            </Button>
          ) : null}
        </div>
        <RadioGroup
          value={selectedOutcomeId ?? undefined}
          onValueChange={setSelectedOutcomeId}
          className="mt-3 gap-1.5"
        >
          {poll.outcomes.map((outcome) => {
            const width =
              poll.totalPool === 0 ? 0 : Math.round((outcome.totalPoints / poll.totalPool) * 100);
            const isWinner = outcome.id === poll.winningOutcomeId;
            const selected = selectedOutcomeId === outcome.id;
            const contents = (
              <>
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 bg-violet-500/15 transition-[width] duration-500",
                    isWinner && "bg-emerald-500/25",
                  )}
                  style={{ width: `${width}%` }}
                />
                <div className="relative flex min-w-0 flex-1 items-center gap-2">
                  {votingOpen ? (
                    <RadioGroupItem
                      id={`poll-choice-${outcome.id}`}
                      value={outcome.id}
                      data-testid={`poll-choice-${outcome.id}`}
                      aria-label={outcome.title}
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate font-medium">{outcome.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {width}% (
                    <OutcomeVotes
                      serverId={serverId}
                      pollId={pollId}
                      outcomeId={outcome.id}
                      count={outcome.bidderCount}
                    />
                    )
                  </span>
                </div>
              </>
            );
            const rowClassName = cn(
              "relative flex w-full items-center gap-2 overflow-hidden rounded-lg bg-muted px-3 py-2 text-left text-sm transition-colors",
              votingOpen && "cursor-pointer hover:bg-muted/80",
              selected && "ring-2 ring-violet-500",
              poll.status === "resolved_pending" && !isWinner && "opacity-45",
            );
            return votingOpen ? (
              <label
                key={outcome.id}
                htmlFor={`poll-choice-${outcome.id}`}
                className={rowClassName}
              >
                {contents}
              </label>
            ) : (
              <div key={outcome.id} className={rowClassName}>
                {contents}
              </div>
            );
          })}
        </RadioGroup>
        {canBid && selectedOutcomeId !== null ? (
          <div className="mt-3 grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium" htmlFor={`poll-bid-amount-${poll.id}`}>
                {m.polls_bid_amount()}
              </label>
              <span className="text-[11px] text-muted-foreground">
                {m.polls_bid_available({ points: points.balance })}
              </span>
            </div>
            <Input
              ref={stakeInputRef}
              id={`poll-bid-amount-${poll.id}`}
              data-testid="poll-bid-amount"
              type="number"
              min={1}
              max={points.balance}
              value={stakeInput}
              onChange={(event) => setStakeInput(event.target.value)}
            />
            <Button data-testid="poll-bid-submit" disabled={!stakeValid} onClick={submitBid}>
              {m.polls_bid_confirm()}
            </Button>
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
          <CoinsIcon className="size-3 shrink-0 text-violet-400" />
          <span>{m.polls_pool({ points: poll.totalPool })}</span>
        </div>
        {poll.status === "resolved_pending" && winning !== undefined && resultNet !== null ? (
          <p
            className={cn(
              "mt-3 text-sm font-semibold",
              resultNet >= 0 ? "text-emerald-500" : "text-destructive",
            )}
          >
            {resultNet >= 0
              ? m.polls_you_won({ points: resultNet })
              : m.polls_you_lost({ points: Math.abs(resultNet) })}
          </p>
        ) : null}
        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted-foreground">{pollStatus(poll, now)}</p>
          {hasCountdown ? (
            <div
              data-testid="poll-time-progress"
              className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
              aria-hidden={true}
            >
              <div
                className="h-full rounded-full bg-violet-500 transition-[width] duration-300 ease-linear"
                style={{ width: `${countdownProgress}%` }}
              />
            </div>
          ) : null}
        </div>
        {poll.myBid !== null && bidOutcome !== undefined && poll.status !== "resolved_pending" ? (
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            {m.polls_your_bid({ points: poll.myBid.stake, outcome: bidOutcome.title })}
          </p>
        ) : null}
        {visible.length > 1 ? (
          <div className="mt-1 flex justify-end gap-1 text-[11px] text-muted-foreground">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={m.polls_previous()}
              onClick={() => move(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <span className="self-center tabular-nums">
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
      </article>
      <PollDialog
        serverId={serverId}
        poll={poll}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialOutcomeId={selectedOutcomeId ?? undefined}
      />
    </div>
  );
}
