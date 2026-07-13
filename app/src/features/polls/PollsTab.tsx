import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import type { Poll, PollDetail } from "@tavern/shared";
import { LIMITS, PollPage } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/apiClient";
import { connectRoom } from "@/lib/wsClient";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { PollDialog } from "./PollDialog";

type Filter = "all" | "active" | "history";

function key(serverId: string): readonly [string, string] {
  return ["polls", serverId];
}

function statusLabel(status: Poll["status"]): string {
  if (status === "open") return m.polls_open();
  if (status === "locked") return m.polls_locked();
  if (status === "resolved_pending") return m.polls_pending();
  if (status === "finalized") return m.polls_finalized();
  return m.polls_voided();
}

export function PollsTab({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [managed, setManaged] = useState<Poll | null>(null);
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: key(serverId) });
  }, [queryClient, serverId]);
  useEffect(() => connectRoom(serverId).on("poll.updated", invalidate), [serverId, invalidate]);

  const query = useInfiniteQuery({
    queryKey: key(serverId),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      apiClient.get(
        `/api/servers/${serverId}/polls?limit=${LIMITS.historyPageSize}${pageParam === undefined ? "" : `&before=${pageParam}`}`,
        PollPage,
      ),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.polls.at(-1)?.createdAt : undefined,
  });
  const polls = useMemo(() => query.data?.pages.flatMap((page) => page.polls) ?? [], [query.data]);
  const shown = polls.filter((poll) => {
    const active =
      poll.status === "open" || poll.status === "locked" || poll.status === "resolved_pending";
    return filter === "all" || (filter === "active" ? active : !active);
  });

  return (
    <div data-testid="polls-tab" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b p-3">
        {(["all", "active", "history"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={filter === value ? "secondary" : "ghost"}
            onClick={() => setFilter(value)}
          >
            {value === "all"
              ? m.polls_all()
              : value === "active"
                ? m.polls_active()
                : m.polls_history()}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {shown.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {m.polls_empty()}
          </div>
        ) : (
          <ul className="grid gap-3 xl:grid-cols-2">
            {shown.map((poll) => (
              <PollHistoryCard
                key={poll.id}
                serverId={serverId}
                poll={poll}
                onManage={() => setManaged(poll)}
              />
            ))}
          </ul>
        )}
        {query.hasNextPage ? (
          <Button
            className="mt-3"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {m.polls_load_more()}
          </Button>
        ) : null}
      </div>
      {managed !== null ? (
        <PollDialog
          serverId={serverId}
          poll={managed}
          open
          onOpenChange={(open) => {
            if (!open) setManaged(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PollHistoryCard({
  serverId,
  poll,
  onManage,
}: {
  serverId: string;
  poll: PollDetail;
  onManage: () => void;
}) {
  const store = roomStore(serverId);
  const serverMeta = useStore(store, (state) => state.serverMeta);
  const currentUserId = useSessionStore((state) => state.profile?.userId ?? null);
  const canManage = poll.creatorId === currentUserId || currentUserId === serverMeta?.adminUserId;
  const winning = poll.outcomes.find((outcome) => outcome.id === poll.winningOutcomeId);
  return (
    <li className="rounded-xl border bg-card p-3" data-testid={`poll-history-${poll.id}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{poll.question}</h3>
          <p className="text-xs text-muted-foreground">
            {m.polls_created_by({ name: poll.creatorDisplayName })}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full bg-muted px-2 py-1 text-xs",
            poll.status === "voided" && "text-destructive",
          )}
        >
          {statusLabel(poll.status)}
        </span>
      </div>
      <div className="mt-3 grid gap-1 text-sm">
        {poll.outcomes.map((outcome) => (
          <div
            key={outcome.id}
            className={cn(
              "flex justify-between rounded-md bg-muted/60 px-2 py-1",
              outcome.id === poll.winningOutcomeId && "bg-emerald-500/15 text-emerald-600",
            )}
          >
            <span>
              {outcome.title}
              {outcome.id === winning?.id ? ` · ${m.polls_winner()}` : ""}
            </span>
            <span className="tabular-nums">{outcome.totalPoints}</span>
          </div>
        ))}
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer font-medium">
          {m.polls_participants()} ({poll.participants.length})
        </summary>
        {poll.participants.length === 0 ? (
          <p className="mt-2 text-muted-foreground">{m.polls_no_bids()}</p>
        ) : (
          <ul className="mt-2 grid gap-1">
            {poll.participants.map((participant) => (
              <li
                key={participant.userId}
                className="flex items-center justify-between gap-3 rounded bg-muted/50 px-2 py-1.5"
              >
                <span className="min-w-0 truncate">{participant.displayName}</span>
                <span
                  className={cn(
                    "shrink-0 text-xs tabular-nums",
                    participant.net > 0 && "text-emerald-500",
                    participant.net < 0 && "text-destructive",
                  )}
                >
                  {m.polls_participant_result({
                    stake: participant.stake,
                    payout: participant.payout,
                    net: participant.net > 0 ? `+${participant.net}` : participant.net,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
      {canManage && poll.status !== "finalized" && poll.status !== "voided" ? (
        <Button size="sm" className="mt-3" onClick={onManage}>
          {m.polls_manage()}
        </Button>
      ) : null}
    </li>
  );
}
