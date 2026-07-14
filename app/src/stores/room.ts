import type {
  ActivityEntry,
  ChatMessage,
  ChatReply,
  CostStatus,
  GifAttachment,
  ImageAttachment,
  Member,
  PointSnapshot,
  Poll,
  ErrorCode,
  RecordingState,
  ServerMessage,
  StreamInfo,
  VoiceState,
} from "@tavern/shared";
import { DEFAULT_POINT_CONFIG, LIMITS } from "@tavern/shared";
import { createStore } from "zustand/vanilla";
import { playUiSound } from "@/lib/uiSounds";
import { connectRoom } from "@/lib/wsClient";
import { useSessionStore } from "@/stores/session";

// Per-server realtime room state (§App-A). One store instance per serverId (factory + registry);
// the wsClient drives it — `hello.ok` REPLACES the whole snapshot (no delta sync), every other
// frame is a targeted reducer. Connection status itself lives on the servers store (connState).
interface ServerMeta {
  id: string;
  nickname: string;
  adminUserId: string;
}

export interface RoomState {
  serverId: string;
  members: Member[];
  messages: ChatMessage[];
  hasOlderHistory: boolean;
  hasNewerHistory: boolean;
  historyInitialized: boolean;
  historyWindow: "timeline" | "around";
  lastReadMessageId: number;
  firstUnreadMessageId: number | null;
  unreadCount: number;
  scrollToMessageId: number | null;
  scrollToMessageToken: number;
  scrollToBottomToken: number;
  replyingTo: ChatReply | null;
  editingMessageId: number | null;
  // FR-14 optimistic echo: nonces of locally-sent messages awaiting their `chat.new` echo. The
  // echo (same nonce) replaces the pending row; a foreign `chat.new` (no nonce) just appends.
  pendingNonces: ReadonlySet<string>;
  voice: VoiceState;
  streams: StreamInfo[];
  // § watching indicator: live (viewer → trackName) pairs from the `watch.state` broadcast — drives
  // the eye icon on voice member chips. Snapshot-not-delta (like voice.state); reset on resnapshot
  // (hello.ok carries no watching field, mirroring the streams stub).
  watching: Array<{ userId: string; trackName: string }>;
  // FR-33 focus mode: the single watched tile pulled fullscreen (high simulcast layer). Local-only
  // (never a wire frame); at most one focused tile at a time; cleared on resnapshot and when the
  // focused stream is removed.
  focusedTrackName: string | null;
  // Voice avatars participate in the same focus layout as streams. Kept as a separate typed id so
  // stream-only actions (screenshots, theater delivery) can never receive a synthetic track name;
  // the two setters enforce that at most one stream/avatar focus exists.
  focusedVoiceUserId: string | null;
  // Theater fullscreen: the single stream or avatar blown up to fill the whole window (a fixed overlay
  // above the shell — sidebar/header/chat hidden, WS + chat still live). Local-only; at most one target.
  // Esc or the tile's minimize button exits.
  fullscreenTrackName: string | null;
  fullscreenVoiceUserId: string | null;
  recording: RecordingState;
  activityTail: ActivityEntry[];
  serverMeta: ServerMeta | null;
  // §header status: the shared free-text server status (≤128 chars), editable by any member. Seeded
  // by `hello.ok`, live-updated by `status.updated`; "" means no status set. Last write wins.
  status: string;
  kicked: boolean;
  lastProtocolError: string | null;
  // §8 G5 warn threshold: set by the `cost.warning` broadcast; the banner (S12.3 CostBanner) shows
  // while set and not dismissed. Dismissal is per-session (store flag, no persistence) and survives
  // resnapshots — hello.ok deliberately does not touch either field.
  costWarning: { usedGB: number; capGB: number } | null;
  costWarningDismissed: boolean;
  // §8 G5 live egress meter for the Stats tab: seeded by hello.ok's costStatus, refreshed by the
  // 60s `cost.update` broadcast while voice is active. Null only before the first snapshot.
  cost: CostStatus | null;
  points: PointSnapshot;
  polls: Poll[];
  pollError: ErrorCode | null;
  dismissCostWarning: () => void;
  apply: (msg: ServerMessage) => void;
  // FR-39 live activity: append an `activity.new` entry, deduped by id (an entry can arrive both via
  // the live tail and via an Activity-tab query refetch), capping the tail at ACTIVITY_TAIL_MAX.
  appendActivity: (entry: ActivityEntry) => void;
  setProtocolError: (message: string) => void;
  // §header status: trim + length-guard, then fire `status.set { text }`. The authoritative value
  // arrives back via the `status.updated` broadcast (no optimistic write — last write wins server-side).
  setStatus: (text: string) => void;
  // FR-14: trim + length-guard, append a pending row, and fire `chat.send { body, nonce }`. An
  // optional `gif` (§ GIF picker) rides along; with a gif the body may be empty (a pure-GIF send).
  sendMessage: (body: string, gif?: GifAttachment, image?: ImageAttachment) => void;
  loadInitial: () => void;
  loadOlder: () => Promise<void>;
  loadNewer: () => Promise<void>;
  loadLatest: () => void;
  jumpToMessage: (messageId: number) => void;
  jumpToUnread: () => void;
  markRead: (messageId: number) => void;
  setReplyingTo: (reply: ChatReply | null) => void;
  startEditing: (messageId: number | null) => void;
  editMessage: (messageId: number, body: string) => void;
  deleteMessage: (messageId: number) => void;
  setReaction: (messageId: number, emoji: string, reacted: boolean) => void;
  createPoll: (question: string, outcomes: string[], durationSeconds: number) => void;
  bidPoll: (pollId: string, outcomeId: string, stake: number) => void;
  lockPoll: (pollId: string) => void;
  resolvePoll: (pollId: string, outcomeId: string) => void;
  correctPoll: (pollId: string, outcomeId: string) => void;
  voidPoll: (pollId: string) => void;
  clearPollError: () => void;
  // FR-33: set (or clear with null) the focused tile. Enforces exactly-one by holding a single value.
  setFocusedTrackName: (trackName: string | null) => void;
  setFocusedVoiceUserId: (userId: string | null) => void;
  // Theater fullscreen: set (or clear with null) the fullscreen tile. Exactly-one, same as focus.
  setFullscreenTrackName: (trackName: string | null) => void;
  setFullscreenVoiceUserId: (userId: string | null) => void;
}

const ACTIVITY_TAIL_MAX = 200;

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].toSorted((a, b) => a.id - b.id);
}

function updateMessageAndReplies(messages: ChatMessage[], updated: ChatMessage): ChatMessage[] {
  return messages.map((message) => {
    if (message.id === updated.id) return updated;
    if (message.reply?.id !== updated.id) return message;
    return {
      ...message,
      reply: {
        id: updated.id,
        userId: updated.userId,
        body: updated.body,
        deleted: updated.deletedAt !== undefined,
        ...(updated.gif === undefined ? {} : { gif: updated.gif }),
        ...(updated.image === undefined ? {} : { image: updated.image }),
      },
    };
  });
}

function updateMessageReaction(
  messages: ChatMessage[],
  messageId: number,
  emoji: string,
  reaction: ChatMessage["reactions"][number] | null,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    const index = message.reactions.findIndex((item) => item.emoji === emoji);
    if (reaction === null) {
      return { ...message, reactions: message.reactions.filter((item) => item.emoji !== emoji) };
    }
    if (index < 0) return { ...message, reactions: [...message.reactions, reaction] };
    return {
      ...message,
      reactions: message.reactions.map((item, itemIndex) =>
        itemIndex === index ? reaction : item,
      ),
    };
  });
}

function reduce(state: RoomState, msg: ServerMessage): Partial<RoomState> {
  switch (msg.t) {
    case "hello.ok":
      // Full snapshot replaces room state (§6.2 no-delta resync).
      return {
        members: msg.members,
        voice: msg.voice,
        streams: msg.streams,
        watching: [],
        recording: msg.recording,
        serverMeta: msg.serverMeta,
        status: msg.status,
        cost: msg.costStatus,
        points: msg.points,
        polls: msg.polls,
        pollError: null,
        messages: [],
        hasOlderHistory: false,
        hasNewerHistory: false,
        historyInitialized: false,
        historyWindow: "timeline",
        lastReadMessageId: msg.lastReadMessageId,
        firstUnreadMessageId: msg.firstUnreadMessageId,
        unreadCount: msg.unreadCount,
        // Initial positioning belongs to MessageList's history lifecycle. Keep this command channel
        // for explicit reply/unread jumps so an old target cannot replay when the panel remounts.
        scrollToMessageId: null,
        replyingTo: null,
        editingMessageId: null,
        pendingNonces: new Set<string>(),
        activityTail: [],
        kicked: false,
        lastProtocolError: null,
        focusedTrackName: null,
        focusedVoiceUserId: null,
        fullscreenTrackName: null,
        fullscreenVoiceUserId: null,
      };
    case "chat.new":
      return {
        ...(state.historyWindow === "timeline" && !state.hasNewerHistory
          ? { messages: mergeMessages(state.messages, [msg.message]) }
          : {}),
        ...(msg.message.userId !== useSessionStore.getState().profile?.userId
          ? {
              unreadCount: state.unreadCount + 1,
              firstUnreadMessageId: state.firstUnreadMessageId ?? msg.message.id,
            }
          : {}),
      };
    case "chat.page":
      if (msg.mode === "initial" || msg.mode === "latest" || msg.mode === "around") {
        return {
          messages: mergeMessages(
            state.messages.filter((message) => message.id < 0),
            msg.messages,
          ),
          hasOlderHistory: msg.hasOlder,
          hasNewerHistory: msg.hasNewer,
          historyInitialized: true,
          historyWindow: msg.mode === "around" ? "around" : "timeline",
        };
      }
      return {
        messages: mergeMessages(state.messages, msg.messages),
        hasOlderHistory: msg.mode === "older" ? msg.hasOlder : state.hasOlderHistory,
        hasNewerHistory: msg.mode === "newer" ? msg.hasNewer : state.hasNewerHistory,
      };
    case "chat.updated":
    case "chat.deleted":
      return {
        messages: updateMessageAndReplies(state.messages, msg.message),
        ...(msg.t === "chat.deleted" &&
        msg.message.userId !== useSessionStore.getState().profile?.userId &&
        msg.message.id > state.lastReadMessageId
          ? {
              unreadCount: Math.max(0, state.unreadCount - 1),
              ...(state.unreadCount === 1 ? { firstUnreadMessageId: null } : {}),
            }
          : {}),
      };
    case "chat.read-state":
      return {
        lastReadMessageId: msg.lastReadMessageId,
        firstUnreadMessageId: msg.firstUnreadMessageId,
        unreadCount: msg.unreadCount,
      };
    case "chat.reaction.updated":
      return {
        messages: updateMessageReaction(state.messages, msg.messageId, msg.emoji, msg.reaction),
      };
    case "presence.update":
      return {
        members: state.members.map((mem) =>
          mem.userId === msg.userId ? { ...mem, presence: msg.presence } : mem,
        ),
      };
    case "member.update":
      return {
        members: state.members.map((mem) =>
          mem.userId === msg.profile.userId ? { ...mem, ...msg.profile } : mem,
        ),
      };
    case "member.joined":
      return {
        members: [...state.members.filter((mem) => mem.userId !== msg.member.userId), msg.member],
      };
    case "member.left":
      return {
        members: state.members.filter((mem) => mem.userId !== msg.userId),
        ...(state.focusedVoiceUserId === msg.userId ? { focusedVoiceUserId: null } : {}),
        ...(state.fullscreenVoiceUserId === msg.userId ? { fullscreenVoiceUserId: null } : {}),
      };
    case "voice.state":
      return {
        voice: msg.voice,
        ...(state.focusedVoiceUserId !== null &&
        !msg.voice.members.some((member) => member.userId === state.focusedVoiceUserId)
          ? { focusedVoiceUserId: null }
          : {}),
        ...(state.fullscreenVoiceUserId !== null &&
        !msg.voice.members.some((member) => member.userId === state.fullscreenVoiceUserId)
          ? { fullscreenVoiceUserId: null }
          : {}),
      };
    case "stream.added":
      return {
        streams: [...state.streams.filter((s) => s.trackName !== msg.stream.trackName), msg.stream],
        ...(msg.stream.kind === "webcam" && state.focusedVoiceUserId === msg.stream.userId
          ? { focusedTrackName: msg.stream.trackName, focusedVoiceUserId: null }
          : {}),
        ...(msg.stream.kind === "webcam" && state.fullscreenVoiceUserId === msg.stream.userId
          ? { fullscreenTrackName: msg.stream.trackName, fullscreenVoiceUserId: null }
          : {}),
      };
    case "stream.updated":
      return {
        streams: state.streams.map((s) =>
          s.trackName === msg.trackName
            ? {
                ...s,
                preset: msg.preset,
                ...(msg.preview === undefined ? {} : { preview: msg.preview }),
              }
            : s,
        ),
      };
    case "stream.removed": {
      // Dropping a stream also drops any focus/fullscreen on it (exactly-one invariants).
      const removed = state.streams.find((stream) => stream.trackName === msg.trackName);
      const avatarUserId =
        removed?.kind === "webcam" &&
        state.voice.members.some((member) => member.userId === removed.userId)
          ? removed.userId
          : null;
      return {
        streams: state.streams.filter((s) => s.trackName !== msg.trackName),
        ...(state.focusedTrackName === msg.trackName
          ? {
              focusedTrackName: null,
              ...(avatarUserId === null ? {} : { focusedVoiceUserId: avatarUserId }),
            }
          : {}),
        ...(state.fullscreenTrackName === msg.trackName
          ? {
              fullscreenTrackName: null,
              ...(avatarUserId === null ? {} : { fullscreenVoiceUserId: avatarUserId }),
            }
          : {}),
      };
    }
    case "watch.state":
      return { watching: msg.watching };
    // `activity.new` is handled in `apply` via `appendActivity` (dedup by id) — never reaches here.
    case "rec.state":
      return { recording: msg.recording };
    case "server.updated":
      return state.serverMeta
        ? { serverMeta: { ...state.serverMeta, nickname: msg.nickname } }
        : {};
    case "status.updated":
      // §header status: the server broadcasts the authoritative text after any member's set.
      return { status: msg.text };
    case "kicked":
      // The only `kicked` signal (consumed by S5.2's ServerPage); close follows on the wire.
      return { kicked: true };
    case "cost.warning":
      // §8 G5: latch the warn payload for the CostBanner (S12.3). Dismissed state is untouched —
      // the broadcast fires once per month-bucket, so a re-latch after dismissal is a new month.
      return { costWarning: { usedGB: msg.usedGB, capGB: msg.capGB } };
    case "cost.update":
      // Live egress meter refresh (60s alarm tick) — feeds the Stats tab's free-limit readout.
      return { cost: msg.cost };
    case "points.updated":
      return { points: msg.points };
    case "poll.updated":
      return {
        polls: [...state.polls.filter((poll) => poll.id !== msg.poll.id), msg.poll].toSorted(
          (a, b) => a.createdAt - b.createdAt,
        ),
      };
    case "member.icon.updated":
      return {
        members: state.members.map((member) => {
          if (member.userId !== msg.userId) return member;
          if (msg.icon === null) {
            const { marketIcon: _removed, ...withoutIcon } = member;
            return withoutIcon;
          }
          return { ...member, marketIcon: msg.icon };
        }),
      };
    default:
      // error / pong / sound/market update nudges carry no room-state delta.
      return {};
  }
}

export function createRoomStore(serverId: string) {
  // Optimistic rows get decreasing negative ids (server ids are positive AUTOINCREMENT), so a row
  // is "pending" iff `id < 0`. `nonceToId` maps a pending nonce to its synthetic id for echo
  // reconciliation; it is closure-private (the pinned public surface is `pendingNonces`).
  const nonceToId = new Map<string, number>();
  const pollRequestIds = new Set<string>();
  let syntheticSeq = 0;
  let pendingReadMessageId = 0;
  const requestHistory = (
    mode: "initial" | "latest" | "older" | "newer" | "around",
    cursorId?: number,
  ): void => {
    try {
      connectRoom(serverId).send({
        t: "chat.history",
        requestId: crypto.randomUUID(),
        mode,
        ...(cursorId === undefined ? {} : { cursorId }),
        limit: LIMITS.historyPageSize,
      });
    } catch {
      // Reconnect resnapshots the room; visible sentinels then request the required window again.
    }
  };

  return createStore<RoomState>((set, get) => ({
    serverId,
    members: [],
    messages: [],
    hasOlderHistory: false,
    hasNewerHistory: false,
    historyInitialized: false,
    historyWindow: "timeline",
    lastReadMessageId: 0,
    firstUnreadMessageId: null,
    unreadCount: 0,
    scrollToMessageId: null,
    scrollToMessageToken: 0,
    scrollToBottomToken: 0,
    replyingTo: null,
    editingMessageId: null,
    pendingNonces: new Set<string>(),
    voice: { members: [], sessionStartedAt: null },
    streams: [],
    watching: [],
    focusedTrackName: null,
    focusedVoiceUserId: null,
    fullscreenTrackName: null,
    fullscreenVoiceUserId: null,
    recording: { active: false },
    activityTail: [],
    serverMeta: null,
    status: "",
    kicked: false,
    lastProtocolError: null,
    costWarning: null,
    costWarningDismissed: false,
    cost: null,
    points: {
      balance: 0,
      pendingPollWinnings: 0,
      currentRatePerMinute: 0,
      activeSources: [],
      today: {
        day: new Date().toISOString().slice(0, 10),
        conversation: 0,
        streaming: 0,
        watching: 0,
        total: 0,
      },
      config: DEFAULT_POINT_CONFIG,
    },
    polls: [],
    pollError: null,
    dismissCostWarning: () => set({ costWarningDismissed: true }),
    apply: (msg) => {
      if (msg.t === "hello.ok") {
        nonceToId.clear();
        pendingReadMessageId = 0;
        set((state) => reduce(state, msg));
        return;
      }
      if (msg.t === "chat.read-state" && msg.lastReadMessageId >= pendingReadMessageId) {
        pendingReadMessageId = 0;
      }
      if (msg.t === "activity.new") {
        get().appendActivity(msg.entry);
        return;
      }
      if (msg.t === "error" && msg.ref !== undefined && pollRequestIds.delete(msg.ref)) {
        set({ pollError: msg.code });
        return;
      }
      if (msg.t === "poll.updated" && msg.requestId !== undefined) {
        pollRequestIds.delete(msg.requestId);
        set({ pollError: null });
      }
      if (msg.t === "chat.new" && msg.nonce !== undefined) {
        const nonce = msg.nonce;
        const tempId = nonceToId.get(nonce);
        if (tempId !== undefined) {
          // Reconcile: replace the pending optimistic row with the authoritative echoed message.
          nonceToId.delete(nonce);
          const echoed = msg.message;
          set((state) => {
            const pending = new Set(state.pendingNonces);
            pending.delete(nonce);
            return {
              messages: state.messages.map((mm) => (mm.id === tempId ? echoed : mm)),
              pendingNonces: pending,
            };
          });
          return;
        }
      }
      set((state) => reduce(state, msg));
    },
    appendActivity: (entry) =>
      set((state) => {
        if (state.activityTail.some((e) => e.id === entry.id)) return {};
        return { activityTail: [...state.activityTail, entry].slice(-ACTIVITY_TAIL_MAX) };
      }),
    setProtocolError: (message) => set({ lastProtocolError: message }),
    setStatus: (text) => {
      // Trim + cap to the wire limit; the DO re-validates. No optimistic write — the `status.updated`
      // broadcast carries the authoritative value back (last write wins server-side).
      const trimmed = text.trim().slice(0, LIMITS.statusMaxChars);
      try {
        connectRoom(serverId).send({ t: "status.set", text: trimmed });
      } catch {
        // WS not open — the set is dropped; the field reverts to the last broadcast value on reopen.
      }
    },
    sendMessage: (body, gif, image) => {
      const trimmed = body.trim();
      if (trimmed.length > LIMITS.messageMaxChars) return;
      // Empty body is only sendable when a gif or image rides along (a pure-attachment message);
      // otherwise no-op.
      if (trimmed.length < 1 && gif === undefined && image === undefined) return;
      const nonce = crypto.randomUUID();
      syntheticSeq -= 1;
      const tempId = syntheticSeq;
      nonceToId.set(nonce, tempId);
      const self = useSessionStore.getState().profile;
      const reply = get().replyingTo;
      const optimistic: ChatMessage = {
        id: tempId,
        userId: self?.userId ?? "",
        body: trimmed,
        mentions: [],
        at: Date.now(),
        reactions: [],
        ...(gif === undefined ? {} : { gif }),
        ...(image === undefined ? {} : { image }),
        ...(reply === null ? {} : { reply }),
      };
      set((state) => {
        const pending = new Set(state.pendingNonces);
        pending.add(nonce);
        return {
          messages: [...state.messages, optimistic],
          pendingNonces: pending,
          replyingTo: null,
          scrollToBottomToken: state.scrollToBottomToken + 1,
        };
      });
      playUiSound("chat.send");
      if (get().historyWindow === "around" || get().hasNewerHistory) requestHistory("latest");
      try {
        connectRoom(serverId).send({
          t: "chat.send",
          body: trimmed,
          nonce,
          ...(gif === undefined ? {} : { gif }),
          ...(image === undefined ? {} : { image }),
          ...(reply === null ? {} : { replyToId: reply.id }),
        });
      } catch {
        // WS not open — the optimistic row stays; a reconnect resnapshot (hello.ok) clears it.
      }
    },
    setFocusedTrackName: (trackName) =>
      set({
        focusedTrackName: trackName,
        ...(trackName === null ? {} : { focusedVoiceUserId: null }),
      }),
    setFocusedVoiceUserId: (userId) =>
      set({
        focusedVoiceUserId: userId,
        ...(userId === null
          ? {}
          : { focusedTrackName: null, fullscreenTrackName: null, fullscreenVoiceUserId: null }),
      }),
    setFullscreenTrackName: (trackName) =>
      set({
        fullscreenTrackName: trackName,
        ...(trackName === null ? {} : { focusedVoiceUserId: null, fullscreenVoiceUserId: null }),
      }),
    setFullscreenVoiceUserId: (userId) =>
      set({
        fullscreenVoiceUserId: userId,
        ...(userId === null
          ? {}
          : {
              focusedVoiceUserId: userId,
              focusedTrackName: null,
              fullscreenTrackName: null,
            }),
      }),
    loadInitial: () => requestHistory("initial"),
    loadOlder: async () => {
      const { messages } = get();
      const oldest = messages.find((message) => message.id > 0);
      if (oldest !== undefined) requestHistory("older", oldest.id);
    },
    loadNewer: async () => {
      const newest = get().messages.findLast((message) => message.id > 0);
      if (newest !== undefined) requestHistory("newer", newest.id);
    },
    loadLatest: () => {
      set((state) => ({ scrollToBottomToken: state.scrollToBottomToken + 1 }));
      requestHistory("latest");
    },
    jumpToMessage: (messageId) => {
      const loaded = get().messages.some((message) => message.id === messageId);
      set((state) => ({
        scrollToMessageId: messageId,
        scrollToMessageToken: state.scrollToMessageToken + 1,
      }));
      if (loaded) return;
      requestHistory("around", messageId);
    },
    jumpToUnread: () => {
      const firstUnread = get().firstUnreadMessageId;
      set((state) => ({
        scrollToMessageId: firstUnread,
        scrollToMessageToken: state.scrollToMessageToken + 1,
      }));
      requestHistory("initial");
    },
    markRead: (messageId) => {
      if (messageId <= Math.max(get().lastReadMessageId, pendingReadMessageId)) return;
      try {
        connectRoom(serverId).send({ t: "chat.read", messageId });
        pendingReadMessageId = messageId;
      } catch {
        // The server remains authoritative; reconnect returns the last durable read cursor.
      }
    },
    setReplyingTo: (replyingTo) => set({ replyingTo }),
    startEditing: (editingMessageId) => set({ editingMessageId }),
    editMessage: (messageId, body) => {
      try {
        connectRoom(serverId).send({
          t: "chat.edit",
          requestId: crypto.randomUUID(),
          messageId,
          body,
        });
        set({ editingMessageId: null });
      } catch {
        // Keep the authoritative row unchanged when disconnected.
      }
    },
    deleteMessage: (messageId) => {
      try {
        connectRoom(serverId).send({
          t: "chat.delete",
          requestId: crypto.randomUUID(),
          messageId,
        });
      } catch {
        // Keep the authoritative row unchanged when disconnected.
      }
    },
    setReaction: (messageId, emoji, reacted) => {
      try {
        connectRoom(serverId).send({
          t: "chat.reaction.set",
          requestId: crypto.randomUUID(),
          messageId,
          emoji,
          reacted,
        });
      } catch {
        // The authoritative message remains unchanged; reconnect/history restores reaction state.
      }
    },
    createPoll: (question, outcomes, durationSeconds) => {
      const requestId = crypto.randomUUID();
      pollRequestIds.add(requestId);
      try {
        connectRoom(serverId).send({
          t: "poll.create",
          requestId,
          question,
          outcomes,
          durationSeconds,
        });
      } catch {
        pollRequestIds.delete(requestId);
        set({ pollError: "bad_request" });
      }
    },
    bidPoll: (pollId, outcomeId, stake) => {
      const requestId = crypto.randomUUID();
      pollRequestIds.add(requestId);
      try {
        connectRoom(serverId).send({ t: "poll.bid", requestId, pollId, outcomeId, stake });
      } catch {
        pollRequestIds.delete(requestId);
        set({ pollError: "bad_request" });
      }
    },
    lockPoll: (pollId) => {
      const requestId = crypto.randomUUID();
      pollRequestIds.add(requestId);
      try {
        connectRoom(serverId).send({ t: "poll.lock", requestId, pollId });
      } catch {
        pollRequestIds.delete(requestId);
        set({ pollError: "bad_request" });
      }
    },
    resolvePoll: (pollId, outcomeId) => {
      const requestId = crypto.randomUUID();
      pollRequestIds.add(requestId);
      try {
        connectRoom(serverId).send({ t: "poll.resolve", requestId, pollId, outcomeId });
      } catch {
        pollRequestIds.delete(requestId);
        set({ pollError: "bad_request" });
      }
    },
    correctPoll: (pollId, outcomeId) => {
      const requestId = crypto.randomUUID();
      pollRequestIds.add(requestId);
      try {
        connectRoom(serverId).send({ t: "poll.correct", requestId, pollId, outcomeId });
      } catch {
        pollRequestIds.delete(requestId);
        set({ pollError: "bad_request" });
      }
    },
    voidPoll: (pollId) => {
      const requestId = crypto.randomUUID();
      pollRequestIds.add(requestId);
      try {
        connectRoom(serverId).send({ t: "poll.void", requestId, pollId });
      } catch {
        pollRequestIds.delete(requestId);
        set({ pollError: "bad_request" });
      }
    },
    clearPollError: () => set({ pollError: null }),
  }));
}

const registry = new Map<string, ReturnType<typeof createRoomStore>>();

// Lazily creates and caches one room store per serverId (A6 keeps a socket per joined server).
export function roomStore(serverId: string): ReturnType<typeof createRoomStore> {
  const existing = registry.get(serverId);
  if (existing) return existing;
  const store = createRoomStore(serverId);
  registry.set(serverId, store);
  return store;
}

export function resetRoomStores(): void {
  registry.clear();
}
