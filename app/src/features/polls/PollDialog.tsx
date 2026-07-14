import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { Poll } from "@tavern/shared";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

export function PollDialog({
  serverId,
  poll,
  open,
  onOpenChange,
  initialOutcomeId,
}: {
  serverId: string;
  poll: Poll;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialOutcomeId?: string | undefined;
}) {
  const store = roomStore(serverId);
  const currentUserId = useSessionStore((state) => state.profile?.userId ?? null);
  const serverMeta = useStore(store, (state) => state.serverMeta);
  const lockPoll = useStore(store, (state) => state.lockPoll);
  const resolvePoll = useStore(store, (state) => state.resolvePoll);
  const correctPoll = useStore(store, (state) => state.correctPoll);
  const voidPoll = useStore(store, (state) => state.voidPoll);
  const firstOutcomeId = poll.outcomes[0]?.id ?? "";
  const canManage = currentUserId === poll.creatorId || currentUserId === serverMeta?.adminUserId;
  const [outcomeId, setOutcomeId] = useState(firstOutcomeId);
  const canCorrect =
    poll.status === "resolved_pending" &&
    !poll.correctionUsed &&
    poll.finalizesAt !== null &&
    Date.now() < poll.finalizesAt;

  useEffect(() => {
    setOutcomeId(
      initialOutcomeId !== undefined &&
        poll.outcomes.some((outcome) => outcome.id === initialOutcomeId)
        ? initialOutcomeId
        : firstOutcomeId,
    );
  }, [firstOutcomeId, initialOutcomeId, poll.id, poll.outcomes]);

  function close(): void {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={`poll-dialog-${poll.id}`} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.polls_manage()}</DialogTitle>
          <DialogDescription>
            {m.polls_created_by({ name: poll.creatorDisplayName })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {poll.outcomes.map((outcome) => (
            <button
              type="button"
              key={outcome.id}
              data-testid={`poll-choice-${outcome.id}`}
              aria-pressed={outcomeId === outcome.id}
              onClick={() => setOutcomeId(outcome.id)}
              className="flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm aria-pressed:border-violet-500 aria-pressed:bg-violet-500/10"
            >
              <span>{outcome.title}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {outcome.totalPoints}
              </span>
            </button>
          ))}
        </div>
        {poll.myBid !== null ? (
          <p className="rounded-lg bg-muted p-2 text-sm">
            {m.polls_your_bid({
              points: poll.myBid.stake,
              outcome:
                poll.outcomes.find((outcome) => outcome.id === poll.myBid?.outcomeId)?.title ?? "",
            })}
          </p>
        ) : null}
        <DialogFooter className="flex-wrap">
          {canManage && poll.status === "open" ? (
            <Button
              variant="outline"
              onClick={() => {
                lockPoll(poll.id);
                close();
              }}
            >
              {m.polls_lock()}
            </Button>
          ) : null}
          {canManage && poll.status === "locked" ? (
            <Button
              data-testid="poll-resolve-submit"
              onClick={() => {
                resolvePoll(poll.id, outcomeId);
                close();
              }}
            >
              {m.polls_resolve_confirm()}
            </Button>
          ) : null}
          {canManage && canCorrect ? (
            <Button
              data-testid="poll-correct-submit"
              onClick={() => {
                correctPoll(poll.id, outcomeId);
                close();
              }}
            >
              {m.polls_correct_confirm()}
            </Button>
          ) : null}
          {canManage &&
          poll.status !== "finalized" &&
          poll.status !== "voided" &&
          (!poll.correctionUsed || poll.status !== "resolved_pending") ? (
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button variant="destructive" data-testid="poll-void-submit" />}
              >
                {m.polls_void()}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{m.polls_void_confirm_title()}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {m.polls_void_confirm_description()}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
                  <AlertDialogAction
                    data-testid="poll-void-confirm"
                    onClick={() => {
                      voidPoll(poll.id);
                      close();
                    }}
                  >
                    {m.polls_void()}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
