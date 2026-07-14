import type { ChatReply, GifResult, Member } from "@tavern/shared";
import { LIMITS } from "@tavern/shared";
import { SmileIcon, XIcon } from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  useLayoutEffect,
  useEffect,
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
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { GifPicker } from "./GifPicker";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { PointsButton } from "./PointsButton";
import { PollCreateButton } from "@/features/polls/PollCreateButton";
import { chatImageViewUrl, firstImageFile } from "./uploadChatImage";
import { useChatImageUpload } from "./useChatImageUpload";

// FR-14/15 message composer: auto-growing textarea (1–5 rows), Enter-to-send / Shift+Enter newline,
// a >2000 send guard + live counter, a frimousse emoji picker in a popover, and `@username`
// autocomplete. All product logic (trim + length guard + optimistic echo) lives in the room store;
// this component only edits text and drives selection.
const COUNTER_THRESHOLD = 1800; // the live counter appears strictly above this (pinned)
const MAX_ROWS = 5;
// The word immediately left of the caret, when it is an `@handle` — opens the autocomplete.
const MENTION_WORD = /(?:^|\s)(@[a-z0-9_]*)$/i;

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

function ContextThumbnail({
  message,
  serverId,
}: {
  message: Pick<ChatReply, "gif" | "image">;
  serverId: string;
}) {
  const src =
    message.image !== undefined
      ? chatImageViewUrl(serverId, message.image.id)
      : message.gif?.previewUrl;
  if (src === undefined) return null;
  return (
    <img
      data-testid="composer-context-thumbnail"
      src={src}
      alt=""
      className="size-10 shrink-0 rounded object-cover"
    />
  );
}

export function Composer({ serverId }: { serverId: string }) {
  const store = roomStore(serverId);
  const sendMessage = useStore(store, (s) => s.sendMessage);
  const members = useStore(store, (s) => s.members);
  const messages = useStore(store, (s) => s.messages);
  const replyingTo = useStore(store, (s) => s.replyingTo);
  const setReplyingTo = useStore(store, (s) => s.setReplyingTo);
  const editingMessageId = useStore(store, (s) => s.editingMessageId);
  const historyWindow = useStore(store, (s) => s.historyWindow);
  const hasNewerHistory = useStore(store, (s) => s.hasNewerHistory);
  const startEditing = useStore(store, (s) => s.startEditing);
  const editMessage = useStore(store, (s) => s.editMessage);

  const [value, setValue] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Paste-to-upload shares the same hook (single-flight guard + spinner state) as the chat drop zone.
  const { uploading, sendFile } = useChatImageUpload(serverId);

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
  const editingMessage = messages.find((message) => message.id === editingMessageId);
  const canSend =
    !overLimit &&
    (value.trim().length > 0 ||
      (editingMessage !== undefined &&
        (editingMessage.gif !== undefined || editingMessage.image !== undefined)));
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

  useEffect(() => {
    if (editingMessageId === null) return;
    const target = messages.find((message) => message.id === editingMessageId);
    if (target === undefined) return;
    setValue(target.body);
    setReplyingTo(null);
    textareaRef.current?.focus();
  }, [editingMessageId, messages, setReplyingTo]);

  useEffect(() => {
    if (replyingTo !== null) textareaRef.current?.focus();
  }, [replyingTo]);

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
    if (editingMessageId !== null) editMessage(editingMessageId, value);
    else sendMessage(value);
    setValue("");
    setMention(null);
  }

  // § chat image paste: Ctrl/Cmd+V of a copied image uploads it to R2 and sends it as its own message
  // (empty body + image attachment), Discord-style. A paste that carries image bytes preempts the
  // default text paste (`preventDefault`) so the image's alt-text/URL doesn't also land in the box; a
  // paste with no image bytes falls through to the normal text paste.
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const file = firstImageFile(event.clipboardData);
    if (!file) return; // no image on the clipboard → let the default text paste proceed
    event.preventDefault();
    sendFile(file);
  }

  // § GIF picker: a picked GIF sends immediately as its own message (empty body + gif attachment,
  // Discord-style), independent of whatever text is currently typed. Strips the provider `id` — only
  // the `GifAttachment` fields are persisted.
  function pickGif(result: GifResult): void {
    sendMessage("", {
      url: result.url,
      previewUrl: result.previewUrl,
      width: result.width,
      height: result.height,
    });
    setGifOpen(false);
  }

  function cancelContext(): void {
    if (editingMessageId !== null) {
      startEditing(null);
      setValue("");
    }
    if (replyingTo !== null) setReplyingTo(null);
    setMention(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape" && (replyingTo !== null || editingMessageId !== null)) {
      event.preventDefault();
      cancelContext();
      return;
    }
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
    if (
      event.key === "ArrowUp" &&
      value.length === 0 &&
      editingMessageId === null &&
      historyWindow === "timeline" &&
      !hasNewerHistory
    ) {
      const selfId = useSessionStore.getState().profile?.userId;
      const latest = messages.findLast(
        (message) => message.id > 0 && message.userId === selfId && message.deletedAt === undefined,
      );
      if (latest !== undefined) {
        event.preventDefault();
        startEditing(latest.id);
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
          serverId={serverId}
          suggestions={suggestions}
          activeIndex={activeIndex}
          onPick={pickMention}
        />
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex items-end gap-2">
          <div
            data-testid="composer-input-shell"
            className="min-w-0 flex-1 overflow-hidden rounded-md border bg-transparent focus-within:ring-1 focus-within:ring-ring"
          >
            {replyingTo !== null ? (
              <div
                data-testid="composer-reply"
                className="flex min-w-0 items-center gap-2 border-b border-l-2 border-l-primary bg-muted/60 px-2 py-1.5 text-xs"
              >
                <ContextThumbnail message={replyingTo} serverId={serverId} />
                <span className="min-w-0 flex-1 truncate">
                  {m.chat_replying_to({ text: replyingTo.body || m.chat_attachment() })}
                </span>
                <button
                  type="button"
                  data-testid="composer-cancel-reply"
                  aria-label={m.chat_cancel_reply()}
                  onClick={cancelContext}
                  className="shrink-0 rounded p-1 hover:bg-accent"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            ) : null}
            {editingMessage !== undefined ? (
              <div
                data-testid="composer-edit"
                className="flex min-w-0 items-center gap-2 border-b border-l-2 border-l-amber-500 bg-muted/60 px-2 py-1.5 text-xs"
              >
                <ContextThumbnail message={editingMessage} serverId={serverId} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{m.chat_editing_message()}</span>
                  <span className="block truncate text-muted-foreground">
                    {editingMessage.body || m.chat_attachment()}
                  </span>
                </span>
                <button
                  type="button"
                  data-testid="composer-cancel-edit"
                  aria-label={m.chat_cancel_edit()}
                  onClick={cancelContext}
                  className="shrink-0 rounded p-1 hover:bg-accent"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            ) : null}
            <div className="relative">
              <textarea
                ref={textareaRef}
                data-testid="composer-input"
                value={value}
                rows={rows}
                onChange={onChange}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                placeholder={m.chat_composer_placeholder()}
                className="block min-h-9 w-full resize-none bg-transparent py-1.5 pr-10 pl-3 text-sm outline-none"
              />
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger
                  data-testid="composer-emoji"
                  aria-label={m.chat_emoji_label()}
                  className="absolute right-1 bottom-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <SmileIcon className="size-4" />
                </PopoverTrigger>
                <PopoverContent
                  data-testid="emoji-popover"
                  align="end"
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
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Popover open={gifOpen} onOpenChange={setGifOpen}>
              <PopoverTrigger
                data-testid="composer-gif"
                aria-label={m.chat_gif_label()}
                className="flex h-8 items-center rounded-md px-2.5 text-xs font-bold text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                {m.chat_gif_label()}
              </PopoverTrigger>
              <PopoverContent
                data-testid="gif-popover"
                align="start"
                side="top"
                className="w-[340px] p-0"
              >
                <GifPicker onPick={pickGif} />
              </PopoverContent>
            </Popover>
            <PointsButton serverId={serverId} />
            <PollCreateButton serverId={serverId} />
          </div>
          <div className="flex items-center gap-2">
            {uploading ? (
              <span
                data-testid="composer-image-uploading"
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Spinner className="size-3.5" />
                {m.chat_image_uploading()}
              </span>
            ) : null}
            <Button
              type="button"
              size="sm"
              data-testid="composer-send"
              disabled={!canSend}
              onClick={submit}
            >
              {editingMessageId === null ? m.chat_composer_send() : m.chat_save_edit()}
            </Button>
          </div>
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
