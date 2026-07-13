import type { ChatMessage, Member } from "@tavern/shared";
import { PencilIcon, ReplyIcon, SmilePlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  EmojiPicker,
  EmojiPickerContent,
  EmojiPickerFooter,
  EmojiPickerSearch,
} from "@/components/ui/emoji-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import { UserProfileName } from "@/features/users/UserProfileName";
import { chatImageViewUrl } from "./uploadChatImage";

interface MessageRowProps {
  message: ChatMessage;
  member: Member | undefined;
  replyMember: Member | undefined;
  members: Member[];
  selfUserId: string | undefined;
  selfUsername: string | undefined;
  serverId: string;
  showUnreadDivider: boolean;
  canEdit: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onJumpToReply: () => void;
  onSetReaction: (emoji: string, reacted: boolean) => void;
}

const MENTION_SPLIT = /(@[a-z0-9_]{3,20})/gi;

function formatTime(at: number): string {
  return new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit" }).format(at);
}

function renderBody(
  message: ChatMessage,
  selfUserId: string | undefined,
  selfUsername: string | undefined,
): ReactNode[] {
  return message.body.split(MENTION_SPLIT).map((part, index) => {
    const key = `${message.id}:${index}`;
    if (index % 2 === 0) return <span key={key}>{part}</span>;
    const handle = part.slice(1).toLowerCase();
    const isSelf =
      selfUserId !== undefined &&
      selfUsername !== undefined &&
      message.mentions.includes(selfUserId) &&
      handle === selfUsername.toLowerCase();
    return (
      <span
        key={key}
        data-testid="mention"
        data-self={isSelf}
        className={cn(
          "rounded px-0.5 font-medium text-primary",
          isSelf && "bg-primary/15 text-primary",
        )}
      >
        {part}
      </span>
    );
  });
}

function RowAvatar({ member }: { member: Member | undefined }) {
  const [failed, setFailed] = useState(false);
  const color = member?.color ?? "#71717a";
  const initial = (member?.displayName ?? "?").charAt(0);
  if (member === undefined || failed) {
    return (
      <span
        className="flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-medium text-white"
        style={{ backgroundColor: color }}
      >
        {initial}
      </span>
    );
  }
  return (
    <img
      src={`/api/media/avatars/${member.userId}.webp`}
      alt={member.displayName}
      onError={() => setFailed(true)}
      className="size-4 shrink-0 rounded-full bg-muted object-cover"
    />
  );
}

function Attachment({ message, serverId }: { message: ChatMessage; serverId: string }) {
  if (message.gif) {
    return (
      <img
        data-testid="message-gif"
        src={message.gif.url}
        alt=""
        loading="lazy"
        width={message.gif.width}
        height={message.gif.height}
        style={{
          aspectRatio: `${message.gif.width} / ${message.gif.height}`,
          maxWidth: "min(320px, 100%)",
        }}
        className="mt-1 block h-auto max-h-80 w-auto rounded-md bg-muted"
      />
    );
  }
  if (!message.image) return null;
  const url = chatImageViewUrl(serverId, message.image.id);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="message-image-open"
      aria-label={m.chat_image_open()}
      className="mt-1 block w-fit"
    >
      <img
        data-testid="message-image"
        src={url}
        alt={m.chat_image_open()}
        loading="lazy"
        width={message.image.width}
        height={message.image.height}
        style={{
          aspectRatio: `${message.image.width} / ${message.image.height}`,
          maxWidth: "min(320px, 100%)",
        }}
        className="block h-auto max-h-80 w-auto rounded-md bg-muted"
      />
    </a>
  );
}

function ReactionCapsules({
  message,
  members,
  selfUserId,
  onSetReaction,
}: {
  message: ChatMessage;
  members: Member[];
  selfUserId: string | undefined;
  onSetReaction: (emoji: string, reacted: boolean) => void;
}) {
  const memberNameById = useMemo(
    () => new Map(members.map((member) => [member.userId, member.displayName])),
    [members],
  );
  const listFormatter = useMemo(
    () => new Intl.ListFormat(getLocale(), { style: "long", type: "conjunction" }),
    [],
  );
  if (message.reactions.length === 0) return null;
  return (
    <TooltipProvider>
      <div data-testid={`message-reactions-${message.id}`} className="mt-1 flex flex-wrap gap-1">
        {message.reactions.map((reaction) => {
          const reactedBySelf = reaction.reactors.some((reactor) => reactor.userId === selfUserId);
          const visibleNames = reaction.reactors
            .slice(0, 8)
            .map((reactor) => memberNameById.get(reactor.userId) ?? reactor.displayName);
          if (reaction.reactors.length > 8) {
            visibleNames.push(m.chat_reaction_others({ n: reaction.reactors.length - 8 }));
          }
          const names = listFormatter.format(visibleNames);
          return (
            <Tooltip key={reaction.emoji}>
              <TooltipTrigger
                type="button"
                data-testid={`reaction-${message.id}-${reaction.emoji}`}
                aria-label={
                  reactedBySelf
                    ? m.chat_reaction_remove({ emoji: reaction.emoji, n: reaction.reactors.length })
                    : m.chat_reaction_add({ emoji: reaction.emoji, n: reaction.reactors.length })
                }
                aria-pressed={reactedBySelf}
                onClick={() => onSetReaction(reaction.emoji, !reactedBySelf)}
                className={cn(
                  "inline-flex h-5 items-center gap-1 rounded-full border-0 bg-muted/25 px-1.5 text-muted-foreground shadow-none transition-colors hover:bg-muted/60 hover:text-foreground",
                  reactedBySelf && "bg-muted/50 text-foreground hover:bg-muted/70",
                )}
              >
                <span aria-hidden="true" className="text-[15px] leading-none">
                  {reaction.emoji}
                </span>
                <span className="text-[10px] leading-none text-muted-foreground">
                  {reaction.reactors.length}
                </span>
              </TooltipTrigger>
              <TooltipContent>{names}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

export function MessageRow({
  message,
  member,
  replyMember,
  members,
  selfUserId,
  selfUsername,
  serverId,
  showUnreadDivider,
  canEdit,
  onReply,
  onEdit,
  onDelete,
  onJumpToReply,
  onSetReaction,
}: MessageRowProps) {
  const [reactionOpen, setReactionOpen] = useState(false);
  const pending = message.id < 0;
  const own = message.userId === selfUserId;
  const deleted = message.deletedAt !== undefined;
  const replyColor = replyMember?.color ?? "#71717a";
  return (
    <>
      {showUnreadDivider ? (
        <li
          data-testid="new-messages-divider"
          className="my-2 flex items-center gap-2 px-3 text-xs font-semibold text-red-500"
        >
          <span className="h-px flex-1 bg-red-500/70" />
          {m.chat_new_messages()}
          <span className="h-px flex-1 bg-red-500/70" />
        </li>
      ) : null}
      <li
        data-testid={`message-${message.id}`}
        data-message-id={message.id}
        className={cn(
          "group/message relative px-3 py-1 data-[highlighted=true]:animate-message-highlight",
          pending && "opacity-60",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <RowAvatar member={member} />
              {member === undefined ? (
                <span className="min-w-0 truncate text-sm font-medium">{message.userId}</span>
              ) : (
                <UserProfileName
                  serverId={serverId}
                  member={member}
                  className="text-sm font-medium"
                />
              )}
            </div>
            <time className="shrink-0 text-xs text-muted-foreground">{formatTime(message.at)}</time>
          </div>
          {message.reply ? (
            <button
              type="button"
              data-testid={`reply-preview-${message.id}`}
              onClick={onJumpToReply}
              style={{ borderLeftColor: replyColor }}
              className="mt-1 flex w-full items-center gap-2 border-l-2 bg-muted/50 px-2 py-1 text-left text-xs hover:bg-muted"
            >
              {message.reply.image ? (
                <img
                  src={chatImageViewUrl(serverId, message.reply.image.id)}
                  alt=""
                  className="size-10 shrink-0 rounded object-cover"
                />
              ) : null}
              {message.reply.gif ? (
                <img
                  src={message.reply.gif.previewUrl}
                  alt=""
                  className="size-10 shrink-0 rounded object-cover"
                />
              ) : null}
              <span className="min-w-0">
                <span
                  data-testid={`reply-author-${message.id}`}
                  className="block truncate font-semibold"
                  style={{ color: replyColor }}
                >
                  {replyMember?.displayName ?? message.reply.userId}
                </span>
                <span className="block truncate text-muted-foreground">
                  {message.reply.deleted
                    ? m.chat_message_deleted()
                    : message.reply.body || m.chat_attachment()}
                </span>
              </span>
            </button>
          ) : null}
          {deleted ? (
            <div
              data-testid={`message-deleted-${message.id}`}
              className="text-sm text-muted-foreground italic"
            >
              {m.chat_message_deleted()}
            </div>
          ) : (
            <>
              {message.body.length > 0 ? (
                <div
                  data-testid={`message-body-${message.id}`}
                  className="text-sm break-words whitespace-pre-wrap"
                >
                  {renderBody(message, selfUserId, selfUsername)}
                  {message.editedAt !== undefined ? (
                    <span className="ml-1 text-xs text-muted-foreground">{m.chat_edited()}</span>
                  ) : null}
                </div>
              ) : null}
              <Attachment message={message} serverId={serverId} />
              <ReactionCapsules
                message={message}
                members={members}
                selfUserId={selfUserId}
                onSetReaction={onSetReaction}
              />
            </>
          )}
        </div>
        {!pending && !deleted ? (
          <div className="absolute -top-3 right-2 flex rounded-md border bg-popover p-0.5 opacity-100 shadow-sm transition-opacity sm:opacity-0 sm:group-hover/message:opacity-100 sm:focus-within:opacity-100">
            <Popover open={reactionOpen} onOpenChange={setReactionOpen}>
              <PopoverTrigger
                data-testid={`add-reaction-${message.id}`}
                aria-label={m.chat_add_reaction()}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <SmilePlusIcon className="size-3.5" />
              </PopoverTrigger>
              <PopoverContent
                data-testid={`reaction-popover-${message.id}`}
                align="end"
                side="top"
                className="w-[320px] p-0"
              >
                <EmojiPicker
                  emojibaseUrl="/emojibase"
                  onEmojiSelect={(picked) => {
                    onSetReaction(picked.emoji, true);
                    setReactionOpen(false);
                  }}
                  className="h-[352px]"
                >
                  <EmojiPickerSearch />
                  <EmojiPickerContent />
                  <EmojiPickerFooter />
                </EmojiPicker>
              </PopoverContent>
            </Popover>
            <button
              type="button"
              data-testid={`reply-message-${message.id}`}
              aria-label={m.chat_reply()}
              onClick={onReply}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ReplyIcon className="size-3.5" />
            </button>
            {canEdit ? (
              <button
                type="button"
                data-testid={`edit-message-${message.id}`}
                aria-label={m.chat_edit()}
                onClick={onEdit}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <PencilIcon className="size-3.5" />
              </button>
            ) : null}
            {own ? (
              <button
                type="button"
                data-testid={`delete-message-${message.id}`}
                aria-label={m.chat_delete()}
                onClick={onDelete}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2Icon className="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    </>
  );
}
