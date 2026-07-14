import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { Spinner } from "@/components/ui/spinner";
import { focusStore } from "@/lib/focusState";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { MessageRow } from "./MessageRow";

const BOTTOM_THRESHOLD_PX = 40;

export function MessageList({ serverId, active = true }: { serverId: string; active?: boolean }) {
  const store = roomStore(serverId);
  const messages = useStore(store, (s) => s.messages);
  const members = useStore(store, (s) => s.members);
  const hasOlder = useStore(store, (s) => s.hasOlderHistory);
  const hasNewer = useStore(store, (s) => s.hasNewerHistory);
  const initialized = useStore(store, (s) => s.historyInitialized);
  const historyWindow = useStore(store, (s) => s.historyWindow);
  const firstUnreadId = useStore(store, (s) => s.firstUnreadMessageId);
  const unreadCount = useStore(store, (s) => s.unreadCount);
  const scrollTarget = useStore(store, (s) => s.scrollToMessageId);
  const scrollTargetToken = useStore(store, (s) => s.scrollToMessageToken);
  const scrollToBottomToken = useStore(store, (s) => s.scrollToBottomToken);
  const loadInitial = useStore(store, (s) => s.loadInitial);
  const loadOlder = useStore(store, (s) => s.loadOlder);
  const loadNewer = useStore(store, (s) => s.loadNewer);
  const loadLatest = useStore(store, (s) => s.loadLatest);
  const jumpToUnread = useStore(store, (s) => s.jumpToUnread);
  const markRead = useStore(store, (s) => s.markRead);
  const setReplyingTo = useStore(store, (s) => s.setReplyingTo);
  const startEditing = useStore(store, (s) => s.startEditing);
  const deleteMessage = useStore(store, (s) => s.deleteMessage);
  const setReaction = useStore(store, (s) => s.setReaction);
  const focused = useStore(focusStore, (s) => s.focused);
  const connectionStatus = useServersStore((s) => s.connState[serverId] ?? "connecting");
  const self = useSessionStore((s) => s.profile);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messageContentRef = useRef<HTMLUListElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const prependHeightRef = useRef<number | null>(null);
  const seenUnreadRef = useRef(new Set<number>());
  // Commands already present when this component mounts belong to its previous lifetime. Initial
  // history positioning below independently chooses first-unread or latest.
  const handledTargetTokenRef = useRef(scrollTargetToken);
  const handledBottomTokenRef = useRef(scrollToBottomToken);
  const initialPositionedRef = useRef(false);
  const initialRequestedRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);

  const memberById = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );
  const latestOwnId = useMemo(
    () =>
      messages.findLast(
        (message) =>
          message.id > 0 && message.userId === self?.userId && message.deletedAt === undefined,
      )?.id ?? null,
    [messages, self?.userId],
  );

  // A newly joined server renders this panel while its socket is still connecting. Wait for the
  // hello handshake before requesting history, and clear the request latch on disconnect so a
  // reconnect retries any request that did not receive a page.
  useEffect(() => {
    if (connectionStatus !== "open") {
      initialRequestedRef.current = false;
      return;
    }
    if (!initialized && !initialRequestedRef.current) {
      initialRequestedRef.current = true;
      loadInitial();
    }
    if (initialized) initialRequestedRef.current = false;
  }, [connectionStatus, initialized, loadInitial]);

  const updateReadState = useCallback(() => {
    const container = scrollRef.current;
    if (!active || !focused || container === null || firstUnreadId === null) return;
    const firstIndex = messages.findIndex((message) => message.id === firstUnreadId);
    if (firstIndex < 0) return;
    const containerRect = container.getBoundingClientRect();
    for (const message of messages.slice(firstIndex)) {
      const row = container.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
      if (row === null) continue;
      const rect = row.getBoundingClientRect();
      const visible = rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      if (visible) seenUnreadRef.current.add(message.id);
    }

    let frontier: number | null = null;
    for (const message of messages.slice(firstIndex)) {
      if (message.userId === self?.userId || message.deletedAt !== undefined) {
        frontier = message.id;
        continue;
      }
      if (!seenUnreadRef.current.has(message.id)) break;
      frontier = message.id;
    }
    if (frontier !== null) markRead(frontier);
  }, [active, firstUnreadId, focused, markRead, messages, self?.userId]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const nextAtBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_THRESHOLD_PX;
    atBottomRef.current = nextAtBottom;
    setAtBottom(nextAtBottom);
    updateReadState();
  }, [updateReadState]);

  useEffect(() => {
    const root = scrollRef.current;
    const top = topSentinelRef.current;
    const bottom = bottomSentinelRef.current;
    if (root === null || top === null || bottom === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === top && hasOlder && !loadingOlderRef.current) {
            loadingOlderRef.current = true;
            prependHeightRef.current = root.scrollHeight;
            void loadOlder();
          }
          if (entry.target === bottom && hasNewer && !loadingNewerRef.current) {
            loadingNewerRef.current = true;
            void loadNewer();
          }
        }
      },
      { root, threshold: 0 },
    );
    observer.observe(top);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [hasNewer, hasOlder, loadNewer, loadOlder]);

  // Attachments reserve their expected dimensions, but their rendered size can still change after
  // React commits (for example once a GIF decodes or responsive styles clamp it). Follow that change
  // only when the existing scroll policy says the reader is already at the bottom.
  useEffect(() => {
    const root = scrollRef.current;
    const content = messageContentRef.current;
    if (!active || root === null || content === null || typeof ResizeObserver === "undefined")
      return;
    const observer = new ResizeObserver(() => {
      if (!atBottomRef.current) return;
      root.scrollTop = root.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [active]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (!initialized) {
      initialPositionedRef.current = false;
      return;
    }
    const previousHeight = prependHeightRef.current;
    if (previousHeight !== null) {
      element.scrollTop += element.scrollHeight - previousHeight;
      prependHeightRef.current = null;
      loadingOlderRef.current = false;
    }
    loadingNewerRef.current = false;

    if (active && !initialPositionedRef.current) {
      if (firstUnreadId === null) {
        element.scrollTop = element.scrollHeight;
        atBottomRef.current = true;
        setAtBottom(true);
        initialPositionedRef.current = true;
      } else {
        const target = element.querySelector<HTMLElement>(`[data-message-id="${firstUnreadId}"]`);
        if (target !== null) {
          target.scrollIntoView({ block: "center" });
          atBottomRef.current = false;
          setAtBottom(false);
          initialPositionedRef.current = true;
        }
      }
    } else if (
      active &&
      scrollTarget !== null &&
      handledTargetTokenRef.current !== scrollTargetToken
    ) {
      const target = element.querySelector<HTMLElement>(`[data-message-id="${scrollTarget}"]`);
      if (target !== null) {
        target.scrollIntoView({ block: "center" });
        atBottomRef.current = false;
        setAtBottom(false);
        target.dataset.highlighted = "true";
        target.addEventListener(
          "animationend",
          () => {
            delete target.dataset.highlighted;
          },
          { once: true },
        );
        handledTargetTokenRef.current = scrollTargetToken;
      }
    } else if (handledBottomTokenRef.current !== scrollToBottomToken) {
      element.scrollTop = element.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
      handledBottomTokenRef.current = scrollToBottomToken;
    } else if (active && atBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
    updateReadState();
  }, [
    active,
    firstUnreadId,
    initialized,
    messages,
    scrollTarget,
    scrollTargetToken,
    scrollToBottomToken,
    updateReadState,
  ]);

  return (
    <div data-testid="message-list" className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-testid="message-scroll"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto py-2"
      >
        <div ref={topSentinelRef} data-testid="message-top-sentinel" className="h-px w-full" />
        {hasOlder ? (
          <div className="flex justify-center py-1 text-muted-foreground">
            <Spinner />
          </div>
        ) : null}
        <ul ref={messageContentRef} className="flex flex-col">
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              member={memberById.get(message.userId)}
              replyMember={message.reply ? memberById.get(message.reply.userId) : undefined}
              members={members}
              selfUserId={self?.userId}
              selfUsername={self?.username}
              serverId={serverId}
              showUnreadDivider={message.id === firstUnreadId}
              canEdit={message.id === latestOwnId && historyWindow === "timeline" && !hasNewer}
              onReply={() =>
                setReplyingTo({
                  id: message.id,
                  userId: message.userId,
                  body: message.body,
                  deleted: message.deletedAt !== undefined,
                  ...(message.gif === undefined ? {} : { gif: message.gif }),
                  ...(message.image === undefined ? {} : { image: message.image }),
                })
              }
              onEdit={() => startEditing(message.id)}
              onDelete={() => deleteMessage(message.id)}
              onJumpToReply={() =>
                message.reply && store.getState().jumpToMessage(message.reply.id)
              }
              onSetReaction={(emoji, reacted) => setReaction(message.id, emoji, reacted)}
            />
          ))}
        </ul>
        {hasNewer ? (
          <div className="flex justify-center py-1 text-muted-foreground">
            <Spinner />
          </div>
        ) : null}
        <div
          ref={bottomSentinelRef}
          data-testid="message-bottom-sentinel"
          className="h-px w-full"
        />
      </div>
      {unreadCount > 0 && !atBottom ? (
        <button
          type="button"
          data-testid="new-message-capsule"
          onClick={jumpToUnread}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg"
        >
          {m.chat_new_messages_count({ n: unreadCount })}
        </button>
      ) : historyWindow === "around" ? (
        <button
          type="button"
          data-testid="back-to-latest"
          onClick={loadLatest}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-3 py-1.5 text-xs font-semibold text-background shadow-lg"
        >
          {m.chat_back_to_latest()}
        </button>
      ) : null}
    </div>
  );
}
