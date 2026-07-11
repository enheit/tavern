import type { CostStatus, Member, StatsResponse as StatsResponseType } from "@tavern/shared";
import { LIMITS, StatsResponse } from "@tavern/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { useStore } from "zustand";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiClient } from "@/lib/apiClient";
import { formatHoursMinutes } from "@/lib/time";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

// FR-40 Stats tab: per-member counters (messages sent, hours streamed) plus the "you watch most"
// ranking. All figures come from the server-authoritative snapshot at GET /api/servers/:id/stats;
// the endpoint's per-(viewer→streamer) `watchPairs` are what answer "who do I watch the most".
//
// The query is enabled ONLY while this tab is active (ChatTabs keeps the Stats panel mounted and
// toggles `active`): flipping `enabled` false→true on tab activation re-runs the query when its data
// is older than `staleTime` (10s) — the pinned refetch-on-activation mechanism, no manual refetch().

interface StatRow {
  userId: string;
  messages: number;
  streamSeconds: number;
  member: Member | undefined;
}

// Members table order (pinned): messages DESC, tie-break displayName ASC. A userId missing from the
// room-store member map (a departed member) has an empty name key, so it tie-breaks first.
function toSortedRows(perUser: StatsResponseType["perUser"], byId: Map<string, Member>): StatRow[] {
  return perUser
    .map((p): StatRow => ({ ...p, member: byId.get(p.userId) }))
    .toSorted((a, b) =>
      b.messages !== a.messages
        ? b.messages - a.messages
        : (a.member?.displayName ?? "").localeCompare(b.member?.displayName ?? ""),
    );
}

// The member cell chat uses (MessageRow): a 28px avatar (img → colored-initial fallback on 404) next
// to the displayName in the member's color. A departed member renders a muted label and no avatar.
function MemberCell({ member }: { member: Member | undefined }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  if (member === undefined) {
    return (
      <span data-testid="stats-former-member" className="text-sm text-muted-foreground">
        {m.stats_former_member()}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      {avatarFailed ? (
        <span
          data-testid={`stats-avatar-fallback-${member.userId}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
          style={{ backgroundColor: member.color }}
        >
          {member.displayName.charAt(0)}
        </span>
      ) : (
        <img
          src={`/api/media/avatars/${member.userId}.webp`}
          alt={member.displayName}
          data-testid={`stats-avatar-img-${member.userId}`}
          onError={() => setAvatarFailed(true)}
          className="size-7 shrink-0 rounded-full bg-muted object-cover"
        />
      )}
      <span className="truncate text-sm font-medium" style={{ color: member.color }}>
        {member.displayName}
      </span>
    </span>
  );
}

// §8 G5 live free-limit readout: seeded by hello.ok's costStatus, refreshed by the 60s cost.update
// broadcast while voice is active. The figure is the DO meter's ESTIMATE (App-D bitrate × watch
// time, video pulls only): it over-counts vs real Cloudflare egress (encoders send under their caps)
// and skips audio — the note under the bar says exactly that. Warn marker at 700 GB, cap at 900.
function EgressMeter({ cost }: { cost: CostStatus | null }) {
  if (cost === null) return null;
  const pct = Math.min(100, (cost.usedGB / cost.capGB) * 100);
  const warnPct = Math.min(100, (LIMITS.egressWarnGB / cost.capGB) * 100);
  const warned = cost.usedGB >= LIMITS.egressWarnGB;
  return (
    <section data-testid="stats-egress" className="border-b px-3 py-3">
      <h3 className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {m.stats_egress_title()}
      </h3>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted">
        <div
          data-testid="stats-egress-bar"
          className={cn(
            "h-full rounded-full",
            cost.blocked ? "bg-destructive" : warned ? "bg-amber-500" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-y-0 w-px bg-border" style={{ left: `${warnPct}%` }} />
      </div>
      <div className="flex items-baseline justify-between gap-2 pt-1.5">
        <span data-testid="stats-egress-used" className="text-sm tabular-nums">
          {m.stats_egress_used({ used: cost.usedGB.toFixed(1), cap: cost.capGB })}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {m.stats_egress_warn({ warn: LIMITS.egressWarnGB })}
        </span>
      </div>
      {cost.blocked && (
        <p data-testid="stats-egress-blocked" className="pt-1 text-xs text-destructive">
          {m.stats_egress_blocked()}
        </p>
      )}
      <p className="pt-1 text-xs text-muted-foreground">{m.stats_egress_note()}</p>
    </section>
  );
}

// "You watch most" (FR-40): the viewer's own watch pairs, seconds DESC, capped at 5.
function WatchMost({
  watchPairs,
  selfUserId,
  byId,
}: {
  watchPairs: StatsResponseType["watchPairs"];
  selfUserId: string | undefined;
  byId: Map<string, Member>;
}) {
  const top = watchPairs
    .filter((p) => selfUserId !== undefined && p.viewerId === selfUserId)
    .toSorted((a, b) => b.seconds - a.seconds)
    .slice(0, 5);
  return (
    <section data-testid="stats-watch-most" className="px-3 py-3">
      <h3 className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {m.stats_you_watch_most()}
      </h3>
      {top.length === 0 ? (
        <p data-testid="stats-no-watch-data" className="text-sm text-muted-foreground">
          {m.stats_no_watch_data()}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {top.map((pair) => {
            const streamer = byId.get(pair.streamerId);
            return (
              <li
                key={pair.streamerId}
                data-testid="stats-watch-row"
                data-streamer-id={pair.streamerId}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="truncate" style={{ color: streamer?.color }}>
                  {streamer?.displayName ?? m.stats_former_member()}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatHoursMinutes(pair.seconds)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function StatsTab({ serverId, active }: { serverId: string; active: boolean }) {
  const members = useStore(roomStore(serverId), (s) => s.members);
  const cost = useStore(roomStore(serverId), (s) => s.cost);
  const selfUserId = useSessionStore((s) => s.profile?.userId);

  const query = useQuery({
    queryKey: ["stats", serverId],
    queryFn: () => apiClient.get(`/api/servers/${serverId}/stats`, StatsResponse),
    enabled: active,
    staleTime: 10_000,
  });

  // The egress meter renders regardless of the FR-40 query (it is store-fed, live even while the
  // per-member snapshot loads); the query drives only the body below it.
  const stats = query.data;
  let body: ReactNode;
  if (stats === undefined) {
    // No text while the first snapshot is still loading (or the tab has never been activated).
    body = <div data-testid="stats-loading" className="flex-1" />;
  } else if (stats.perUser.length === 0) {
    body = (
      <div
        data-testid="stats-empty"
        className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground"
      >
        {m.stats_empty()}
      </div>
    );
  } else {
    const byId = new Map<string, Member>(members.map((mem): [string, Member] => [mem.userId, mem]));
    const rows = toSortedRows(stats.perUser, byId);
    body = (
      <>
        <Table data-testid="stats-members-table">
          <TableHeader>
            <TableRow>
              <TableHead>{m.stats_member()}</TableHead>
              <TableHead className="text-right">{m.stats_messages()}</TableHead>
              <TableHead className="text-right">{m.stats_hours_streamed()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.userId} data-testid="stats-row" data-user-id={row.userId}>
                <TableCell>
                  <MemberCell member={row.member} />
                </TableCell>
                <TableCell
                  data-testid={`stats-messages-${row.userId}`}
                  className="text-right tabular-nums"
                >
                  {row.messages}
                </TableCell>
                <TableCell
                  data-testid={`stats-hours-${row.userId}`}
                  className="text-right tabular-nums"
                >
                  {formatHoursMinutes(row.streamSeconds)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <WatchMost watchPairs={stats.watchPairs} selfUserId={selfUserId} byId={byId} />
      </>
    );
  }

  return (
    <div data-testid="stats-tab" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <EgressMeter cost={cost} />
      {body}
    </div>
  );
}
