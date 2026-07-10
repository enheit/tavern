import type {
  ActivityEntry,
  ChatMessage,
  Member,
  RecordingState,
  ServerMessage,
  StreamInfo,
  VoiceState,
} from "@tavern/shared";
import { createStore } from "zustand/vanilla";

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
  voice: VoiceState;
  streams: StreamInfo[];
  recording: RecordingState;
  activityTail: ActivityEntry[];
  serverMeta: ServerMeta | null;
  kicked: boolean;
  lastProtocolError: string | null;
  apply: (msg: ServerMessage) => void;
  setProtocolError: (message: string) => void;
}

const ACTIVITY_TAIL_MAX = 50;

function reduce(state: RoomState, msg: ServerMessage): Partial<RoomState> {
  switch (msg.t) {
    case "hello.ok":
      // Full snapshot replaces room state (§6.2 no-delta resync).
      return {
        members: msg.members,
        voice: msg.voice,
        streams: msg.streams,
        recording: msg.recording,
        serverMeta: msg.serverMeta,
        messages: [],
        hasMoreHistory: msg.lastMessageId !== null,
        activityTail: [],
        kicked: false,
        lastProtocolError: null,
      };
    case "chat.new":
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
      return { streams: state.streams.filter((s) => s.trackName !== msg.trackName) };
    case "activity.new":
      return { activityTail: [...state.activityTail, msg.entry].slice(-ACTIVITY_TAIL_MAX) };
    case "rec.state":
      return { recording: msg.recording };
    case "server.updated":
      return state.serverMeta
        ? { serverMeta: { ...state.serverMeta, nickname: msg.nickname } }
        : {};
    case "kicked":
      // The only `kicked` signal (consumed by S5.2's ServerPage); close follows on the wire.
      return { kicked: true };
    default:
      // error / pong / sound.played / sound.updated / cost.warning carry no room-state delta.
      return {};
  }
}

export function createRoomStore(serverId: string) {
  return createStore<RoomState>((set) => ({
    serverId,
    members: [],
    messages: [],
    hasMoreHistory: false,
    voice: { members: [], sessionStartedAt: null },
    streams: [],
    recording: { active: false },
    activityTail: [],
    serverMeta: null,
    kicked: false,
    lastProtocolError: null,
    apply: (msg) => set((state) => reduce(state, msg)),
    setProtocolError: (message) => set({ lastProtocolError: message }),
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
