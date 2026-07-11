import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { Spinner } from "@/components/ui/spinner";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { MessageRow } from "./MessageRow";

// FR-14/17 scrolling message history. Sticks to the bottom while the user is at the bottom; a top
// IntersectionObserver sentinel drives `loadOlder()` while `hasMoreHistory` (this also fetches the
// FIRST page — `hello.ok` leaves `messages` empty). After a prepend the scroll position is restored
// by the scrollHeight delta so the viewport does not jump.
const BOTTOM_THRESHOLD_PX = 40;

export function MessageList({ serverId }: { serverId: string }) {
  const store = roomStore(serverId);
  const messages = useStore(store, (s) => s.messages);
  const members = useStore(store, (s) => s.members);
  const hasMore = useStore(store, (s) => s.hasMoreHistory);
  const loadOlder = useStore(store, (s) => s.loadOlder);
  const self = useSessionStore((s) => s.profile);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const loadingRef = useRef(false);
  const prependRef = useRef<number | null>(null);

  const memberById = useMemo(() => new Map(members.map((mem) => [mem.userId, mem])), [members]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (el === null || sentinel === null || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting !== true) return;
        if (loadingRef.current) return;
        loadingRef.current = true;
        prependRef.current = el.scrollHeight;
        void loadOlder();
      },
      { root: el, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, loadOlder]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const prevHeight = prependRef.current;
    if (prevHeight !== null) {
      // A prepend just landed — keep the same messages under the viewport.
      el.scrollTop += el.scrollHeight - prevHeight;
      prependRef.current = null;
      loadingRef.current = false;
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  return (
    <div data-testid="message-list" className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-testid="message-scroll"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto py-2"
      >
        <div ref={sentinelRef} data-testid="message-top-sentinel" className="h-px w-full" />
        {hasMore ? (
          <div className="flex justify-center py-1 text-muted-foreground">
            <Spinner />
          </div>
        ) : null}
        <ul className="flex flex-col">
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              member={memberById.get(message.userId)}
              selfUserId={self?.userId}
              selfUsername={self?.username}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
