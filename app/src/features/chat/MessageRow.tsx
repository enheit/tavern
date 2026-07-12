import type { ChatMessage, Member } from "@tavern/shared";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import { chatImageViewUrl } from "./uploadChatImage";

// One chat row (FR-14/15/17): a small avatar + displayName in the member's color, HH:mm time, and a
// pre-wrapped body with `@mention` highlighting. A row with a negative (synthetic) id is a pending
// optimistic echo (§ room store) and renders at 60% opacity until the server echo replaces it.
interface MessageRowProps {
  message: ChatMessage;
  member: Member | undefined;
  selfUserId: string | undefined;
  selfUsername: string | undefined;
  // The active server — needed to build a pasted image's public capability URL (§ chat image paste).
  serverId: string;
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

// A really small (16px) avatar rendered inline before the nickname; falls back to a colored
// initial block when the member is unknown or the avatar image 404s.
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

export function MessageRow({
  message,
  member,
  selfUserId,
  selfUsername,
  serverId,
}: MessageRowProps) {
  const pending = message.id < 0;
  const displayName = member?.displayName ?? message.userId;
  return (
    <li data-testid={`message-${message.id}`} className={cn("px-3 py-1", pending && "opacity-60")}>
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <RowAvatar member={member} />
            <span className="min-w-0 truncate text-sm font-medium" style={{ color: member?.color }}>
              {displayName}
            </span>
          </div>
          <time className="shrink-0 text-xs text-muted-foreground">{formatTime(message.at)}</time>
        </div>
        {message.body.length > 0 ? (
          <div
            data-testid={`message-body-${message.id}`}
            className="text-sm break-words whitespace-pre-wrap"
          >
            {renderBody(message, selfUserId, selfUsername)}
          </div>
        ) : null}
        {message.gif ? (
          <img
            data-testid="message-gif"
            src={message.gif.url}
            alt=""
            loading="lazy"
            width={message.gif.width}
            height={message.gif.height}
            // Intrinsic w/h + a fixed aspect-ratio box reserve space so the row doesn't jump when the
            // GIF loads; CSS caps the on-screen size while preserving ratio. `min(320px, 100%)` caps at
            // 320px OR the chat column width, whichever is smaller — a wide GIF in a narrow column can
            // never overflow (a bare `320px` would, forcing the whole chat to scroll horizontally).
            style={{
              aspectRatio: `${message.gif.width} / ${message.gif.height}`,
              maxWidth: "min(320px, 100%)",
            }}
            className="mt-1 block h-auto max-h-80 w-auto rounded-md bg-muted"
          />
        ) : null}
        {message.image ? (
          // A pasted image (§ chat image paste). Clicking opens the full image in a NEW browser tab —
          // the same public capability URL as the inline thumbnail, so it works in the web app and, in
          // Electron, via setWindowOpenHandler → the OS default browser. Intrinsic w/h + a fixed
          // aspect-ratio box reserve space so the row doesn't jump on load; `min(320px, 100%)` caps the
          // on-screen size at 320px OR the column width, whichever is smaller (a wide image in a narrow
          // column can never force the chat to scroll horizontally).
          <a
            href={chatImageViewUrl(serverId, message.image.id)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="message-image-open"
            aria-label={m.chat_image_open()}
            className="mt-1 block w-fit"
          >
            <img
              data-testid="message-image"
              src={chatImageViewUrl(serverId, message.image.id)}
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
        ) : null}
      </div>
    </li>
  );
}
