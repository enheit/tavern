import type { Member } from "@tavern/shared";
import { LIMITS } from "@tavern/shared";
import { SmileIcon } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import {
  EmojiPicker,
  EmojiPickerContent,
  EmojiPickerFooter,
  EmojiPickerSearch,
} from "@/components/ui/emoji-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { MentionAutocomplete } from "./MentionAutocomplete";

// FR-14/15 message composer: auto-growing textarea (1–5 rows), Enter-to-send / Shift+Enter newline,
// a >2000 send guard + live counter, a frimousse emoji picker in a popover, and `@username`
// autocomplete. All product logic (trim + length guard + optimistic echo) lives in the room store;
// this component only edits text and drives selection.
const COUNTER_THRESHOLD = 1800; // the live counter appears strictly above this (pinned)
const MAX_ROWS = 5;
// The word immediately left of the caret, when it is an `@handle` — opens the autocomplete.
const MENTION_WORD = /(?:^|\s)(@[a-z0-9_]*)$/i;
// Emoji picker temporarily hidden (per request); flip back to re-enable the button + popover.
const SHOW_EMOJI = false;

interface MentionState {
  query: string;
  start: number;
  end: number;
}

function detectMention(value: string, caret: number): MentionState | null {
  const match = MENTION_WORD.exec(value.slice(0, caret));
  const token = match?.[1];
  if (token === undefined) return null;
  return { query: token.slice(1), start: caret - token.length, end: caret };
}

export function Composer({ serverId }: { serverId: string }) {
  const store = roomStore(serverId);
  const sendMessage = useStore(store, (s) => s.sendMessage);
  const members = useStore(store, (s) => s.members);

  const [value, setValue] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const suggestions = useMemo(() => {
    if (mention === null) return [];
    const query = mention.query.toLowerCase();
    return members.filter((mem) => mem.username.toLowerCase().startsWith(query)).slice(0, 6);
  }, [mention, members]);

  const rows = Math.min(MAX_ROWS, Math.max(1, value.split("\n").length));
  const overLimit = value.length > LIMITS.messageMaxChars;
  const showCounter = value.length > COUNTER_THRESHOLD;
  const canSend = value.trim().length > 0 && !overLimit;
  const autocompleteOpen = mention !== null && suggestions.length > 0;

  // Apply a queued caret position after the controlled value re-renders (mention pick / emoji
  // insert) and refocus the textarea.
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const ta = textareaRef.current;
    if (caret === null || ta === null) return;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    pendingCaret.current = null;
  }, [value]);

  function onChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    const next = event.target.value;
    setValue(next);
    setMention(detectMention(next, event.target.selectionStart));
    setActiveIndex(0);
  }

  function pickMention(member: Member): void {
    if (mention === null) return;
    const insert = `@${member.username} `;
    const next = value.slice(0, mention.start) + insert + value.slice(mention.end);
    pendingCaret.current = mention.start + insert.length;
    setValue(next);
    setMention(null);
  }

  function insertEmoji(emoji: string): void {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const next = value.slice(0, caret) + emoji + value.slice(caret);
    pendingCaret.current = caret + emoji.length;
    setValue(next);
    setEmojiOpen(false);
    setMention(null);
  }

  function submit(): void {
    if (!canSend) return;
    sendMessage(value);
    setValue("");
    setMention(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (autocompleteOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        // While the autocomplete is open, Enter selects a mention — it never sends (pinned).
        event.preventDefault();
        const chosen = suggestions[activeIndex];
        if (chosen !== undefined) pickMention(chosen);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div data-testid="composer" className="relative p-2">
      {autocompleteOpen ? (
        <MentionAutocomplete
          suggestions={suggestions}
          activeIndex={activeIndex}
          onPick={pickMention}
        />
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex items-end gap-2">
          {SHOW_EMOJI ? (
            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger
                data-testid="composer-emoji"
                aria-label={m.chat_emoji_label()}
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <SmileIcon className="size-5" />
              </PopoverTrigger>
              <PopoverContent
                data-testid="emoji-popover"
                align="start"
                side="top"
                className="w-[320px] p-0"
              >
                <EmojiPicker
                  emojibaseUrl="/emojibase"
                  onEmojiSelect={(picked) => insertEmoji(picked.emoji)}
                  className="h-[352px]"
                >
                  <EmojiPickerSearch />
                  <EmojiPickerContent />
                  <EmojiPickerFooter />
                </EmojiPicker>
              </PopoverContent>
            </Popover>
          ) : null}
          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            value={value}
            rows={rows}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={m.chat_composer_placeholder()}
            className="min-h-9 flex-1 resize-none rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            data-testid="composer-send"
            disabled={!canSend}
            onClick={submit}
          >
            {m.chat_composer_send()}
          </Button>
        </div>
      </div>
      {showCounter ? (
        <div
          data-testid="composer-counter"
          className={cn(
            "mt-1 text-right text-xs text-muted-foreground",
            overLimit && "text-destructive",
          )}
        >
          {m.chat_composer_counter({ n: value.length })}
        </div>
      ) : null}
    </div>
  );
}
