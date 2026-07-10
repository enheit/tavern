import type { Member, StatsResponse as StatsResponseType } from "@tavern/shared";
import { StatsResponse } from "@tavern/shared";
import { useQuery } from "@tanstack/react-query";
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
  const selfUserId = useSessionStore((s) => s.profile?.userId);

  const query = useQuery({
    queryKey: ["stats", serverId],
    queryFn: () => apiClient.get(`/api/servers/${serverId}/stats`, StatsResponse),
    enabled: active,
    staleTime: 10_000,
  });

  const stats = query.data;
  if (stats === undefined) {
    // No text while the first snapshot is still loading (or the tab has never been activated).
    return <div data-testid="stats-loading" className="h-full" />;
  }

  if (stats.perUser.length === 0) {
    return (
      <div
        data-testid="stats-empty"
        className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
      >
        {m.stats_empty()}
      </div>
    );
  }

  const byId = new Map<string, Member>(members.map((mem): [string, Member] => [mem.userId, mem]));
  const rows = toSortedRows(stats.perUser, byId);

  return (
    <div data-testid="stats-tab" className="flex h-full min-h-0 flex-col overflow-y-auto">
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
    </div>
  );
}
