import type { ChatMessage, Member } from "@tavern/shared";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { getLocale } from "@/paraglide/runtime.js";

// One chat row (FR-14/15/17): 32px avatar, displayName in the member's color, HH:mm time, and a
// pre-wrapped body with `@mention` highlighting. A row with a negative (synthetic) id is a pending
// optimistic echo (§ room store) and renders at 60% opacity until the server echo replaces it.
interface MessageRowProps {
  message: ChatMessage;
  member: Member | undefined;
  selfUserId: string | undefined;
  selfUsername: string | undefined;
}

// Split on the mention token but KEEP it (capturing group) so odd indices are the `@handle` tokens.
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
    // A captured `@handle` token. Self-highlight only when I am actually mentioned (my userId is in
    // the server-computed list) AND this token is my username (case-insensitive).
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
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
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
      className="size-8 shrink-0 rounded-full bg-muted object-cover"
    />
  );
}

export function MessageRow({ message, member, selfUserId, selfUsername }: MessageRowProps) {
  const pending = message.id < 0;
  const displayName = member?.displayName ?? message.userId;
  return (
    <li
      data-testid={`message-${message.id}`}
      className={cn("flex gap-2 px-3 py-1", pending && "opacity-60")}
    >
      <RowAvatar member={member} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium" style={{ color: member?.color }}>
            {displayName}
          </span>
          <time className="shrink-0 text-xs text-muted-foreground">{formatTime(message.at)}</time>
        </div>
        <div
          data-testid={`message-body-${message.id}`}
          className="text-sm break-words whitespace-pre-wrap"
        >
          {renderBody(message, selfUserId, selfUsername)}
        </div>
      </div>
    </li>
  );
}
