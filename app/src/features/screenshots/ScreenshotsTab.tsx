import { useCallback, useEffect } from "react";
import { XIcon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import type { ErrorCode, Member, Screenshot } from "@tavern/shared";
import { ApiErrorBody, ScreenshotsResponse } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { connectRoom } from "@/lib/wsClient";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

// § screenshots tab (right-column). Lists the server's captured stream stills newest first, each a
// thumbnail that opens the FULL image in a new browser tab (a public capability URL — no in-app viewer).
// The top-right ✕ removes it (capturer or admin). Space over a focused stream captures new ones; the tab
// live-refetches on the DO's `screenshot.updated` broadcast (App-A has no dedicated screenshot frame).
const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

// The public, unauthenticated image URL (keyed by two UUIDs) — used for BOTH the thumbnail and the
// open-in-new-tab link so viewing works identically in the web app and the Electron→OS-browser path.
function viewUrl(serverId: string, id: string): string {
  return `${API_BASE}/api/screenshots/${serverId}/${id}.webp`;
}

function screenshotsKey(serverId: string): readonly [string, string] {
  return ["screenshots", serverId];
}

function formatDate(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

// DELETE returns 204 (no body) → thin authed fetch (mirrors RecordingsTab.deleteRecording, §9.5 code).
async function deleteScreenshot(serverId: string, id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/servers/${serverId}/screenshots/${id}`, {
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

export function ScreenshotsTab({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const members = useStore(roomStore(serverId), (s) => s.members);
  const selfId = useSessionStore((s) => s.profile?.userId ?? null);
  const locale = useSettingsStore((s) => s.locale);
  const adminUserId = useServersStore(
    (s) => s.servers.find((sv) => sv.id === serverId)?.adminUserId ?? null,
  );

  const query = useQuery({
    queryKey: screenshotsKey(serverId),
    queryFn: () => apiClient.get(`/api/servers/${serverId}/screenshots`, ScreenshotsResponse),
  });

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: screenshotsKey(serverId) });
  }, [queryClient, serverId]);

  // A capture/delete anywhere in the server nudges `screenshot.updated` → refetch so the grid stays live.
  useEffect(
    () => connectRoom(serverId).on("screenshot.updated", invalidate),
    [serverId, invalidate],
  );

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteScreenshot(serverId, id),
    onSuccess: invalidate,
  });

  const screenshots = (query.data?.screenshots ?? []).toSorted((a, b) => b.createdAt - a.createdAt);
  const canManage = (shot: Screenshot): boolean =>
    selfId !== null && (shot.capturedBy === selfId || selfId === adminUserId);

  if (screenshots.length === 0) {
    return (
      <div
        data-testid="screenshots-empty"
        className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
      >
        {m.screenshots_empty()}
      </div>
    );
  }

  return (
    <div data-testid="screenshots-tab" className="min-h-0 flex-1 overflow-y-auto p-3">
      <ul className="grid grid-cols-2 gap-3">
        {screenshots.map((shot) => (
          <ScreenshotCard
            key={shot.id}
            serverId={serverId}
            shot={shot}
            members={members}
            locale={locale}
            canManage={canManage(shot)}
            onDelete={() => deleteMutation.mutate(shot.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function ScreenshotCard({
  serverId,
  shot,
  members,
  locale,
  canManage,
  onDelete,
}: {
  serverId: string;
  shot: Screenshot;
  members: Member[];
  locale: string;
  canManage: boolean;
  onDelete: () => void;
}) {
  const capturer = members.find((mem) => mem.userId === shot.capturedBy);
  const url = viewUrl(serverId, shot.id);

  return (
    <li data-testid={`screenshot-${shot.id}`} className="flex flex-col gap-1">
      <div className="group relative overflow-hidden rounded-lg border bg-black/90">
        {/* Click opens the full still in a NEW browser tab — no custom viewer. In Electron this is an
            https URL, which setWindowOpenHandler hands to the OS default browser. */}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`screenshot-open-${shot.id}`}
          aria-label={m.screenshots_open()}
        >
          <img
            src={url}
            alt={m.screenshots_open()}
            loading="lazy"
            className="aspect-video w-full object-cover"
          />
        </a>
        {canManage && (
          <Button
            size="icon-xs"
            variant="secondary"
            data-testid={`screenshot-delete-${shot.id}`}
            aria-label={m.screenshots_delete()}
            title={m.screenshots_delete()}
            className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
          >
            <XIcon />
          </Button>
        )}
      </div>
      <div className="min-w-0 truncate text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {capturer?.displayName ?? m.activity_former_member()}
        </span>{" "}
        · {formatDate(shot.createdAt, locale)}
      </div>
    </li>
  );
}
