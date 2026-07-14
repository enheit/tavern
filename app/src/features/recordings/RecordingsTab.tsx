import { useCallback, useEffect, useMemo, useRef } from "react";
import { Trash2Icon } from "lucide-react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import type { ErrorCode, Member, Recording } from "@tavern/shared";
import { ApiErrorBody, RecordingsResponse } from "@tavern/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { RecordingPlayer } from "@/features/recordings/RecordingPlayer";
import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { connectRoom } from "@/lib/wsClient";
import { useInfiniteScroll } from "@/lib/useInfiniteScroll";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

// FR-25 Recordings tab (§7.6 right-column). Lists finalized recordings newest first (who/when/duration)
// with in-app playback (RecordingPlayer — custom controls over an authed blob fetch) and starter/admin
// delete. The mm:ss badge comes from the stored duration metadata (recorded WebM has no cues, §7.4).
const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

function recordingsKey(serverId: string): readonly [string, string] {
  return ["recordings", serverId];
}

function formatDuration(ms: number | null): string {
  const total = Math.floor((ms ?? 0) / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function formatDate(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

// DELETE returns 204 (no body) → thin authed fetch (mirrors useSounds.deleteRequest, §9.5 typed code).
async function deleteRecording(serverId: string, recordingId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/servers/${serverId}/recordings/${recordingId}`, {
    method: "DELETE",
    headers: await authTransport.getAuthHeaders(),
    credentials: "include",
  });
  await authTransport.storeFromResponse(res.headers);
  if (!res.ok) {
    let code: ErrorCode = "bad_message";
    try {
      const parsed = ApiErrorBody.safeParse(await res.json());
      if (parsed.success) code = parsed.data.error;
    } catch {
      // Non-JSON error body — keep the generic code.
    }
    throw new ApiError(code, res.status);
  }
}

export function RecordingsTab({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const members = useStore(roomStore(serverId), (s) => s.members);
  const selfId = useSessionStore((s) => s.profile?.userId ?? null);
  const locale = useSettingsStore((s) => s.locale);
  const adminUserId = useServersStore(
    (s) => s.servers.find((sv) => sv.id === serverId)?.adminUserId ?? null,
  );

  const query = useInfiniteQuery({
    queryKey: recordingsKey(serverId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiClient.get(
        `/api/servers/${serverId}/recordings?offset=${pageParam}&limit=30`,
        RecordingsResponse,
      ),
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore
        ? pages.reduce((total, page) => total + page.recordings.length, 0)
        : undefined,
  });

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: recordingsKey(serverId) });
  }, [queryClient, serverId]);

  // The DO nudges `rec.state` on start/stop AND (re-)broadcasts it after a finalize (App-A has no
  // dedicated frame) — refetch so a peer's just-finished recording appears without a reload.
  useEffect(() => connectRoom(serverId).on("rec.state", invalidate), [serverId, invalidate]);

  const deleteMutation = useMutation({
    mutationFn: (recordingId: string) => deleteRecording(serverId, recordingId),
    onSuccess: invalidate,
  });

  const recordings = useMemo(
    () =>
      (query.data?.pages.flatMap((page) => page.recordings) ?? []).toSorted(
        (a, b) => b.startedAt - a.startedAt,
      ),
    [query.data],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useInfiniteScroll({
    scrollRef,
    sentinelRef,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  });
  const canManage = (rec: Recording): boolean =>
    selfId !== null && (rec.startedBy === selfId || selfId === adminUserId);

  if (recordings.length === 0) {
    return (
      <div
        data-testid="recordings-empty"
        className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
      >
        {m.recordings_empty()}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-testid="recordings-tab"
      className="flex h-full min-h-0 flex-col overflow-y-auto"
    >
      <ul className="flex flex-col">
        {recordings.map((rec) => (
          <RecordingRow
            key={rec.id}
            serverId={serverId}
            rec={rec}
            members={members}
            locale={locale}
            canManage={canManage(rec)}
            onDelete={() => deleteMutation.mutate(rec.id)}
          />
        ))}
      </ul>
      <div ref={sentinelRef} data-testid="recordings-sentinel" className="h-px" />
    </div>
  );
}

function RecordingRow({
  serverId,
  rec,
  members,
  locale,
  canManage,
  onDelete,
}: {
  serverId: string;
  rec: Recording;
  members: Member[];
  locale: string;
  canManage: boolean;
  onDelete: () => void;
}) {
  const starter = members.find((mem) => mem.userId === rec.startedBy);
  const url = `${API_BASE}/api/media/recordings/${serverId}/${rec.id}.webm`;

  return (
    <li
      data-testid={`recording-${rec.id}`}
      className="flex flex-col gap-1 border-b px-3 py-2 text-sm"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">
          {starter?.displayName ?? m.activity_former_member()}
        </span>
        <span
          data-testid={`recording-duration-${rec.id}`}
          className="text-muted-foreground tabular-nums"
        >
          {formatDuration(rec.durationMs)}
        </span>
        {canManage && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  data-testid={`recording-delete-${rec.id}`}
                  aria-label={m.recordings_delete()}
                  className="text-destructive"
                />
              }
            >
              <Trash2Icon />
            </AlertDialogTrigger>
            <AlertDialogContent data-testid={`recording-delete-confirm-${rec.id}`}>
              <AlertDialogHeader>
                <AlertDialogTitle>{m.recordings_delete()}</AlertDialogTitle>
                <AlertDialogDescription>{m.recordings_delete_confirm()}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
                <AlertDialogAction data-testid={`recording-delete-do-${rec.id}`} onClick={onDelete}>
                  {m.recordings_delete()}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      <div className="text-xs text-muted-foreground">{formatDate(rec.startedAt, locale)}</div>
      <RecordingPlayer recordingId={rec.id} url={url} durationMs={rec.durationMs} />
    </li>
  );
}
