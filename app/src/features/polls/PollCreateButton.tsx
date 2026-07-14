import { BarChart3Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useStore } from "zustand";
import { LIMITS } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";

const DURATIONS = [30, 60, 120, 300, 600, 900, 1200, 1800] as const;

type DraftOutcome = { id: string; title: string };

function emptyOutcomes(): DraftOutcome[] {
  return [
    { id: crypto.randomUUID(), title: "" },
    { id: crypto.randomUUID(), title: "" },
  ];
}

export function PollCreateButton({ serverId }: { serverId: string }) {
  const createPoll = useStore(roomStore(serverId), (state) => state.createPoll);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [outcomes, setOutcomes] = useState(emptyOutcomes);
  const [duration, setDuration] = useState(120);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const trimmed = outcomes.map((outcome) => outcome.title.trim());
  const unique = new Set(trimmed.map((outcome) => outcome.toLocaleLowerCase()));
  const questionValid =
    question.trim().length > 0 && question.trim().length <= LIMITS.pollQuestionMaxChars;
  const outcomesValid =
    trimmed.length >= LIMITS.pollOutcomeMin &&
    trimmed.length <= LIMITS.pollOutcomeMax &&
    trimmed.every(
      (outcome) => outcome.length > 0 && outcome.length <= LIMITS.pollOutcomeMaxChars,
    ) &&
    unique.size === trimmed.length;

  function reset(): void {
    setQuestion("");
    setOutcomes(emptyOutcomes());
    setDuration(120);
    setSubmitAttempted(false);
  }

  function submit(): void {
    setSubmitAttempted(true);
    if (!questionValid || !outcomesValid) return;
    createPoll(question.trim(), trimmed, duration);
    setOpen(false);
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        data-testid="composer-poll"
        aria-label={m.polls_create()}
        className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <BarChart3Icon className="size-4" />
        {m.polls_title()}
      </DialogTrigger>
      <DialogContent data-testid="poll-create-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.polls_create()}</DialogTitle>
          <DialogDescription>{m.polls_create_description()}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="grid gap-4"
        >
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">{m.polls_question()}</span>
            <Input
              data-testid="poll-question"
              value={question}
              maxLength={LIMITS.pollQuestionMaxChars}
              placeholder={m.polls_question_placeholder()}
              onChange={(event) => setQuestion(event.target.value)}
            />
            {submitAttempted && !questionValid ? (
              <span className="text-xs text-destructive">{m.polls_validation_question()}</span>
            ) : null}
          </label>
          <div className="grid gap-2">
            <span className="text-sm font-medium">{m.polls_outcomes()}</span>
            {outcomes.map((outcome, index) => (
              <div key={outcome.id} className="flex items-center gap-2">
                <Input
                  data-testid={`poll-outcome-${index}`}
                  value={outcome.title}
                  maxLength={LIMITS.pollOutcomeMaxChars}
                  placeholder={m.polls_outcome_placeholder({ number: index + 1 })}
                  onChange={(event) =>
                    setOutcomes((current) =>
                      current.map((value) =>
                        value.id === outcome.id ? { ...value, title: event.target.value } : value,
                      ),
                    )
                  }
                />
                {outcomes.length > LIMITS.pollOutcomeMin ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={m.polls_remove_outcome({ number: index + 1 })}
                    onClick={() =>
                      setOutcomes((current) => current.filter((value) => value.id !== outcome.id))
                    }
                  >
                    <Trash2Icon />
                  </Button>
                ) : null}
              </div>
            ))}
            {outcomes.length < LIMITS.pollOutcomeMax ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="justify-self-start"
                onClick={() =>
                  setOutcomes((current) => [...current, { id: crypto.randomUUID(), title: "" }])
                }
              >
                <PlusIcon />
                {m.polls_add_outcome()}
              </Button>
            ) : null}
            {submitAttempted && !outcomesValid ? (
              <span className="text-xs text-destructive">{m.polls_validation_outcomes()}</span>
            ) : null}
          </div>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">{m.polls_duration()}</span>
            <select
              data-testid="poll-duration"
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
              className="h-8 rounded-lg border border-input bg-background px-2.5"
            >
              {DURATIONS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}
                </option>
              ))}
            </select>
          </label>
          <DialogFooter>
            <Button data-testid="poll-create-submit" type="submit">
              {m.polls_start()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
