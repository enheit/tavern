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
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

export function PollDialog({
  serverId,
  poll,
  open,
  onOpenChange,
}: {
  serverId: string;
  poll: Poll;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const store = roomStore(serverId);
  const points = useStore(store, (state) => state.points);
  const currentUserId = useSessionStore((state) => state.profile?.userId ?? null);
  const serverMeta = useStore(store, (state) => state.serverMeta);
  const bidPoll = useStore(store, (state) => state.bidPoll);
  const lockPoll = useStore(store, (state) => state.lockPoll);
  const resolvePoll = useStore(store, (state) => state.resolvePoll);
  const correctPoll = useStore(store, (state) => state.correctPoll);
  const voidPoll = useStore(store, (state) => state.voidPoll);
  const firstOutcomeId = poll.outcomes[0]?.id ?? "";
  const canManage = currentUserId === poll.creatorId || currentUserId === serverMeta?.adminUserId;
  const [outcomeId, setOutcomeId] = useState(firstOutcomeId);
  const [stake, setStake] = useState(1);
  const canBid = poll.status === "open" && poll.myBid === null;
  const canCorrect =
    poll.status === "resolved_pending" &&
    !poll.correctionUsed &&
    poll.finalizesAt !== null &&
    Date.now() < poll.finalizesAt;

  useEffect(() => {
    setOutcomeId(firstOutcomeId);
    setStake(1);
  }, [firstOutcomeId, poll.id]);

  function close(): void {
    onOpenChange(false);
  }

  function submitBid(): void {
    if (!canBid || outcomeId.length === 0 || stake < 1 || stake > points.balance) return;
    bidPoll(poll.id, outcomeId, stake);
    close();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={`poll-dialog-${poll.id}`} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{poll.question}</DialogTitle>
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
        {canBid ? (
          <label className="grid gap-1.5 text-sm">
            <span className="flex justify-between font-medium">
              {m.polls_bid_amount()}
              <span className="text-xs font-normal text-muted-foreground">
                {m.polls_bid_available({ points: points.balance })}
              </span>
            </span>
            <Input
              data-testid="poll-bid-amount"
              type="number"
              min={1}
              max={points.balance}
              value={stake}
              onChange={(event) => setStake(Number(event.target.value))}
            />
            <span className="text-xs text-muted-foreground">{m.polls_bid_final_hint()}</span>
          </label>
        ) : null}
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
          {canBid ? (
            <Button
              data-testid="poll-bid-submit"
              disabled={points.balance < 1 || stake < 1 || stake > points.balance}
              onClick={submitBid}
            >
              {m.polls_bid_confirm()}
            </Button>
          ) : null}
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
