import type { ErrorCode } from "@tavern/shared";
import { ApiErrorBody } from "@tavern/shared";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ApiError } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { errorMessage } from "@/lib/errorMessage";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";

// FR-11 kick from the admin dialog's Members section. `confirmAndKick(userId)` opens the
// alert-dialog interpolating the member's displayName; the returned `dialog` node is rendered once per
// consumer. (This hook returns JSX, so the module is .tsx.)
export interface KickMember {
  confirmAndKick: (userId: string) => void;
  dialog: ReactNode;
}

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

// DELETE /api/servers/:id/members/:userId returns 204 (no body), which apiClient's JSON-parsing
// request cannot consume — so this uses a thin authed fetch (mirrors useSounds' deleteRequest:
// auth headers + set-auth-token capture + typed ErrorCode on failure).
async function kickRequest(serverId: string, userId: string): Promise<void> {
  const headers = await authTransport.getAuthHeaders();
  const res = await fetch(`${API_BASE}/api/servers/${serverId}/members/${userId}`, {
    method: "DELETE",
    headers,
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

export function useKickMember(serverId: string): KickMember {
  const members = useStore(roomStore(serverId), (s) => s.members);
  const [target, setTarget] = useState<{ userId: string; name: string } | null>(null);

  const confirmAndKick = useCallback(
    (userId: string): void => {
      const name = members.find((mem) => mem.userId === userId)?.displayName ?? "";
      setTarget({ userId, name });
    },
    [members],
  );

  const onConfirm = useCallback(async (): Promise<void> => {
    if (target === null) return;
    const { userId, name } = target;
    setTarget(null);
    try {
      await kickRequest(serverId, userId);
      toast(m.admin_kicked({ name }));
    } catch (err) {
      if (err instanceof ApiError) toast(errorMessage(err.code));
    }
  }, [serverId, target]);

  const dialog = (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
    >
      <AlertDialogContent data-testid="kick-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{m.admin_kick()}</AlertDialogTitle>
          <AlertDialogDescription data-testid="kick-confirm-text">
            {m.admin_kick_confirm({ name: target?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="kick-cancel">{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="kick-confirm-action"
            onClick={() => {
              void onConfirm();
            }}
          >
            {m.admin_kick()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirmAndKick, dialog };
}
