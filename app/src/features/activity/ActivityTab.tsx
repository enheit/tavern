import type { ActivityEntry } from "@tavern/shared";
import { ActivityPage, LIMITS } from "@tavern/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { apiClient } from "@/lib/apiClient";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSettingsStore } from "@/stores/settings";
import { ActivityRow } from "./ActivityRow";

// FR-39 Activity tab: reverse-chronological (newest-first) log of server events. A paginated read
// (`GET /api/servers/:id/activity?before&limit`) supplies history; the room store's live
// `activityTail` (fed by `activity.new` frames) is merged in front, deduped by id, sorted id DESC.
// The list is newest-first, so OLDER pages load as a bottom sentinel scrolls into view.

// undefined pageParam = "newest page" (no `before`); annotated so TanStack infers `number | undefined`.
const INITIAL_PAGE_PARAM: number | undefined = undefined;

export function ActivityTab({ serverId }: { serverId: string }) {
  const store = roomStore(serverId);
  const activityTail = useStore(store, (s) => s.activityTail);
  const members = useStore(store, (s) => s.members);
  const locale = useSettingsStore((s) => s.locale);

  const query = useInfiniteQuery({
    queryKey: ["activity", serverId],
    initialPageParam: INITIAL_PAGE_PARAM,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(LIMITS.historyPageSize) });
      if (pageParam !== undefined) params.set("before", String(pageParam));
      return apiClient.get(`/api/servers/${serverId}/activity?${params.toString()}`, ActivityPage);
    },
    // Cursor = lowest id of the previous page (a page is oldest→newest); undefined once `hasMore` is false.
    getNextPageParam: (lastPage): number | undefined =>
      lastPage.hasMore && lastPage.entries.length > 0
        ? Math.min(...lastPage.entries.map((e) => e.id))
        : undefined,
  });

  const { data, hasNextPage, fetchNextPage } = query;

  const merged = useMemo<ActivityEntry[]>(() => {
    const byId = new Map<number, ActivityEntry>();
    for (const page of data?.pages ?? []) for (const e of page.entries) byId.set(e.id, e);
    for (const e of activityTail) byId.set(e.id, e); // live entries win an id collision (identical)
    return [...byId.values()].toSorted((a, b) => b.id - a.id);
  }, [data, activityTail]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (el === null || sentinel === null || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting === true) void fetchNextPage();
      },
      { root: el, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasNextPage, fetchNextPage]);

  if (merged.length === 0) {
    // No text while the first page is still loading; the empty-state copy shows only once settled.
    return query.isPending ? (
      <div data-testid="activity-loading" className="h-full" />
    ) : (
      <div
        data-testid="activity-empty"
        className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
      >
        {m.activity_empty()}
      </div>
    );
  }

  return (
    <div data-testid="activity-tab" className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        data-testid="activity-scroll"
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        <ul className="flex flex-col">
          {merged.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} members={members} locale={locale} />
          ))}
        </ul>
        <div ref={sentinelRef} data-testid="activity-sentinel" className="h-px w-full" />
      </div>
    </div>
  );
}
