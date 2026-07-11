import { z } from "zod";
import { LIMITS } from "./limits";
import { errorCodeSchema } from "./errors";
import {
  PresetIdSchema,
  UserProfile,
  Member,
  VoiceState,
  StreamInfo,
  RecordingState,
  CostStatus,
  ChatMessage,
  GifAttachment,
  ActivityEntry,
  Presence,
} from "./domain";

const trackName = z.string().min(1).max(128);

// ---- Client → Server (16) ----
const hello = z.object({ t: z.literal("hello"), proto: z.literal(1) });
const chatSend = z.object({
  t: z.literal("chat.send"),
  // Empty body is valid only when a `gif` accompanies it (a pure-GIF send). The DO enforces the
  // "body non-empty OR gif present" invariant; a discriminatedUnion member cannot carry a `.refine`.
  body: z.string().max(LIMITS.messageMaxChars),
  nonce: z.uuid(),
  gif: GifAttachment.optional(),
});
const chatHistory = z.object({
  t: z.literal("chat.history"),
  beforeId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(LIMITS.historyPageSize),
});
const voiceJoin = z.object({ t: z.literal("voice.join") });
const voiceLeave = z.object({ t: z.literal("voice.leave") });
const voiceStateClient = z.object({
  t: z.literal("voice.state"),
  muted: z.boolean(),
  deafened: z.boolean(),
});
const streamStart = z.object({
  t: z.literal("stream.start"),
  kind: z.enum(["screen", "webcam"]),
  trackName,
  audioTrackName: trackName.optional(),
  preset: PresetIdSchema,
});
const streamPreset = z.object({
  t: z.literal("stream.preset"),
  trackName,
  preset: PresetIdSchema,
});
const streamStop = z.object({ t: z.literal("stream.stop"), trackName });
const watchStart = z.object({ t: z.literal("watch.start"), trackName });
const watchStop = z.object({ t: z.literal("watch.stop"), trackName });
const soundPlay = z.object({ t: z.literal("sound.play"), soundId: z.uuid() });
const recStart = z.object({ t: z.literal("rec.start") });
const recStop = z.object({ t: z.literal("rec.stop") });
// Shared server status (§ header status): any connected member may set the free-text status (≤128
// chars); last write wins. Empty string clears it. Persisted per-server; broadcast as `status.updated`.
const statusSet = z.object({
  t: z.literal("status.set"),
  text: z.string().max(LIMITS.statusMaxChars),
});
const ping = z.object({ t: z.literal("ping") });

export const clientMessageSchema = z.discriminatedUnion("t", [
  hello,
  chatSend,
  chatHistory,
  voiceJoin,
  voiceLeave,
  voiceStateClient,
  streamStart,
  streamPreset,
  streamStop,
  watchStart,
  watchStop,
  soundPlay,
  recStart,
  recStop,
  statusSet,
  ping,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---- Server → Client (23) ----
const helloOk = z.object({
  t: z.literal("hello.ok"),
  self: UserProfile,
  serverMeta: z.object({ id: z.uuid(), nickname: z.string(), adminUserId: z.uuid() }),
  members: z.array(Member),
  voice: VoiceState,
  streams: z.array(StreamInfo),
  recording: RecordingState,
  status: z.string(),
  lastMessageId: z.number().int().nullable(),
  costStatus: CostStatus,
});
const errorMsg = z.object({
  t: z.literal("error"),
  code: errorCodeSchema,
  ref: z.string().optional(),
});
const pong = z.object({ t: z.literal("pong") });
const chatNew = z.object({
  t: z.literal("chat.new"),
  message: ChatMessage,
  nonce: z.uuid().optional(),
});
const chatPage = z.object({
  t: z.literal("chat.page"),
  messages: z.array(ChatMessage),
  hasMore: z.boolean(),
});
const activityNew = z.object({ t: z.literal("activity.new"), entry: ActivityEntry });
const presenceUpdate = z.object({
  t: z.literal("presence.update"),
  userId: z.uuid(),
  presence: Presence,
  at: z.number(),
});
const memberUpdate = z.object({
  t: z.literal("member.update"),
  profile: UserProfile,
  at: z.number(),
});
const memberJoined = z.object({ t: z.literal("member.joined"), member: Member, at: z.number() });
const memberLeft = z.object({ t: z.literal("member.left"), userId: z.uuid(), at: z.number() });
const voiceStateServer = z.object({
  t: z.literal("voice.state"),
  voice: VoiceState,
  at: z.number(),
});
const streamAdded = z.object({ t: z.literal("stream.added"), stream: StreamInfo, at: z.number() });
const streamUpdated = z.object({
  t: z.literal("stream.updated"),
  trackName,
  preset: PresetIdSchema,
  at: z.number(),
});
const streamRemoved = z.object({ t: z.literal("stream.removed"), trackName, at: z.number() });
// Who watches what (§ watching indicator): the FULL snapshot of live (viewer → trackName) watch
// grants, broadcast on every grant mutation (watch.start/stop, disconnect sweep, stream close).
// Snapshot-not-delta mirrors voice.state; pairs for since-removed tracks are filtered out.
const watchState = z.object({
  t: z.literal("watch.state"),
  watching: z.array(z.object({ userId: z.uuid(), trackName })),
  at: z.number(),
});
const soundPlayed = z.object({
  t: z.literal("sound.played"),
  soundId: z.uuid(),
  byUserId: z.uuid(),
  at: z.number(),
  // FR-36: the play frame is self-contained so ANY in-voice client can play it without the soundboard
  // panel (and its query cache) being mounted — the voice controller plays straight off this receipt.
  trimStartMs: z.number(),
  trimEndMs: z.number(),
});
const soundUpdated = z.object({ t: z.literal("sound.updated"), at: z.number() });
// The "screenshots list changed" nudge — broadcast after a screenshot is captured or deleted so every
// client's Screenshots tab refetches (App-A has no dedicated screenshot frame, mirrors `sound.updated`).
const screenshotUpdated = z.object({ t: z.literal("screenshot.updated"), at: z.number() });
const recState = z.object({ t: z.literal("rec.state"), recording: RecordingState, at: z.number() });
const serverUpdated = z.object({
  t: z.literal("server.updated"),
  nickname: z.string(),
  at: z.number(),
});
const statusUpdated = z.object({
  t: z.literal("status.updated"),
  text: z.string(),
  at: z.number(),
});
const kicked = z.object({ t: z.literal("kicked"), at: z.number() });
const costWarning = z.object({
  t: z.literal("cost.warning"),
  usedGB: z.number(),
  capGB: z.number(),
  at: z.number(),
});
// Periodic egress-meter refresh for the Stats tab — broadcast on the 60s alarm tick while voice has
// members (hello.ok carries the same CostStatus for the join-time value; this keeps it live).
const costUpdate = z.object({
  t: z.literal("cost.update"),
  cost: CostStatus,
  at: z.number(),
});

export const serverMessageSchema = z.discriminatedUnion("t", [
  helloOk,
  errorMsg,
  pong,
  chatNew,
  chatPage,
  activityNew,
  presenceUpdate,
  memberUpdate,
  memberJoined,
  memberLeft,
  voiceStateServer,
  streamAdded,
  streamUpdated,
  streamRemoved,
  watchState,
  soundPlayed,
  soundUpdated,
  screenshotUpdated,
  recState,
  serverUpdated,
  statusUpdated,
  kicked,
  costWarning,
  costUpdate,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(raw: unknown): ClientMessage {
  return clientMessageSchema.parse(raw);
}

export function parseServerMessage(raw: unknown): ServerMessage {
  return serverMessageSchema.parse(raw);
}

// WS close codes (App-A).
export const CLOSE_PROTOCOL_VIOLATION = 1008;
// Standard 1011: an uncaught server-side handler failure. The client treats it as a normal drop and
// reconnects (fresh ticket → the DO re-seeds a wiped cache from D1, so the retry can heal).
export const CLOSE_INTERNAL_ERROR = 1011;
export const CLOSE_KICKED = 4001;
export const CLOSE_BAD_TICKET = 4002;
export const CLOSE_REPLACED = 4003;
