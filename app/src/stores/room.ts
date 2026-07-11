import type {
  ActivityEntry,
  ChatMessage,
  CostStatus,
  GifAttachment,
  Member,
  RecordingState,
  ServerMessage,
  StreamInfo,
  VoiceState,
} from "@tavern/shared";
import { LIMITS } from "@tavern/shared";
import { createStore } from "zustand/vanilla";
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
  hasMoreHistory: boolean;
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
  // Theater fullscreen: the single stream blown up to fill the whole window (a fixed overlay above the
  // shell — sidebar/header/chat hidden, WS + chat still live). Local-only, orthogonal to focus; at most
  // one; cleared on resnapshot and when its stream is removed. Esc or the tile's minimize button exits.
  fullscreenTrackName: string | null;
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
  sendMessage: (body: string, gif?: GifAttachment) => void;
  // FR-17: request the previous history page (`chat.history { beforeId, limit }`).
  loadOlder: () => Promise<void>;
  // FR-33: set (or clear with null) the focused tile. Enforces exactly-one by holding a single value.
  setFocusedTrackName: (trackName: string | null) => void;
  // Theater fullscreen: set (or clear with null) the fullscreen tile. Exactly-one, same as focus.
  setFullscreenTrackName: (trackName: string | null) => void;
}

const ACTIVITY_TAIL_MAX = 200;

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
        messages: [],
        hasMoreHistory: msg.lastMessageId !== null,
        pendingNonces: new Set<string>(),
        activityTail: [],
        kicked: false,
        lastProtocolError: null,
        focusedTrackName: null,
        fullscreenTrackName: null,
      };
    case "chat.new":
      // A foreign message (no matching pending nonce — echo reconciliation happens in `apply`).
      return { messages: [...state.messages, msg.message] };
    case "chat.page":
      // History pages are older messages fetched upward, so they prepend.
      return { messages: [...msg.messages, ...state.messages], hasMoreHistory: msg.hasMore };
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
      return { members: state.members.filter((mem) => mem.userId !== msg.userId) };
    case "voice.state":
      return { voice: msg.voice };
    case "stream.added":
      return {
        streams: [...state.streams.filter((s) => s.trackName !== msg.stream.trackName), msg.stream],
      };
    case "stream.updated":
      return {
        streams: state.streams.map((s) =>
          s.trackName === msg.trackName ? { ...s, preset: msg.preset } : s,
        ),
      };
    case "stream.removed":
      // Dropping a stream also drops any focus/fullscreen on it (exactly-one invariants).
      return {
        streams: state.streams.filter((s) => s.trackName !== msg.trackName),
        ...(state.focusedTrackName === msg.trackName ? { focusedTrackName: null } : {}),
        ...(state.fullscreenTrackName === msg.trackName ? { fullscreenTrackName: null } : {}),
      };
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
    default:
      // error / pong / sound.played / sound.updated carry no room-state delta.
      return {};
  }
}

export function createRoomStore(serverId: string) {
  // Optimistic rows get decreasing negative ids (server ids are positive AUTOINCREMENT), so a row
  // is "pending" iff `id < 0`. `nonceToId` maps a pending nonce to its synthetic id for echo
  // reconciliation; it is closure-private (the pinned public surface is `pendingNonces`).
  const nonceToId = new Map<string, number>();
  let syntheticSeq = 0;

  return createStore<RoomState>((set, get) => ({
    serverId,
    members: [],
    messages: [],
    hasMoreHistory: false,
    pendingNonces: new Set<string>(),
    voice: { members: [], sessionStartedAt: null },
    streams: [],
    watching: [],
    focusedTrackName: null,
    fullscreenTrackName: null,
    recording: { active: false },
    activityTail: [],
    serverMeta: null,
    status: "",
    kicked: false,
    lastProtocolError: null,
    costWarning: null,
    costWarningDismissed: false,
    cost: null,
    dismissCostWarning: () => set({ costWarningDismissed: true }),
    apply: (msg) => {
      if (msg.t === "hello.ok") {
        nonceToId.clear();
        set((state) => reduce(state, msg));
        return;
      }
      if (msg.t === "activity.new") {
        get().appendActivity(msg.entry);
        return;
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
    sendMessage: (body, gif) => {
      const trimmed = body.trim();
      if (trimmed.length > LIMITS.messageMaxChars) return;
      // Empty body is only sendable when a gif rides along (a pure-GIF message); otherwise no-op.
      if (trimmed.length < 1 && gif === undefined) return;
      const nonce = crypto.randomUUID();
      syntheticSeq -= 1;
      const tempId = syntheticSeq;
      nonceToId.set(nonce, tempId);
      const self = useSessionStore.getState().profile;
      const optimistic: ChatMessage = {
        id: tempId,
        userId: self?.userId ?? "",
        body: trimmed,
        mentions: [],
        at: Date.now(),
        ...(gif === undefined ? {} : { gif }),
      };
      set((state) => {
        const pending = new Set(state.pendingNonces);
        pending.add(nonce);
        return { messages: [...state.messages, optimistic], pendingNonces: pending };
      });
      try {
        connectRoom(serverId).send({
          t: "chat.send",
          body: trimmed,
          nonce,
          ...(gif === undefined ? {} : { gif }),
        });
      } catch {
        // WS not open — the optimistic row stays; a reconnect resnapshot (hello.ok) clears it.
      }
    },
    setFocusedTrackName: (trackName) => set({ focusedTrackName: trackName }),
    setFullscreenTrackName: (trackName) => set({ fullscreenTrackName: trackName }),
    loadOlder: async () => {
      const { messages } = get();
      const oldest = messages[0];
      // Only a real (positive) server id is a valid `beforeId`; a pending row's synthetic negative
      // id would fail the wire schema, so treat a pending-only list as "load the newest page".
      const beforeId = oldest !== undefined && oldest.id > 0 ? oldest.id : undefined;
      try {
        connectRoom(serverId).send({
          t: "chat.history",
          beforeId,
          limit: LIMITS.historyPageSize,
        });
      } catch {
        // WS not open — the top sentinel re-fires loadOlder once the socket reopens.
      }
    },
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
