import { z } from "zod";
import { LIMITS } from "./limits";
import { PRESET_IDS } from "./presets";

// Preset id validator (data lives in presets.ts; the zod enum lives here since presets.ts is zod-free).
export const PresetIdSchema = z.enum(PRESET_IDS);

export const Theme = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof Theme>;

export const Locale = z.enum(["en", "uk"]);
export type Locale = z.infer<typeof Locale>;

export const UserProfile = z.object({
  userId: z.uuid(),
  username: z.string().regex(LIMITS.usernameRe),
  displayName: z.string().min(LIMITS.displayNameMin).max(LIMITS.displayNameMax),
  color: z.string().regex(LIMITS.colorRe),
  avatarKey: z.string().optional(),
});
export type UserProfile = z.infer<typeof UserProfile>;

export const Presence = z.enum(["offline", "online", "in-voice"]);
export type Presence = z.infer<typeof Presence>;

export const Member = UserProfile.extend({
  presence: Presence,
  isAdmin: z.boolean(),
  joinedAt: z.number(),
});
export type Member = z.infer<typeof Member>;

// Member without presence — the shape S3.1's DO seeds its member cache from.
export const MemberInit = UserProfile.extend({
  isAdmin: z.boolean(),
  joinedAt: z.number(),
});
export type MemberInit = z.infer<typeof MemberInit>;

export const StreamInfo = z.object({
  trackName: z.string().min(1).max(128),
  kind: z.enum(["screen", "webcam"]),
  userId: z.uuid(),
  hasAudio: z.boolean(),
  preset: PresetIdSchema,
});
export type StreamInfo = z.infer<typeof StreamInfo>;

export const VoiceMember = z.object({
  userId: z.uuid(),
  muted: z.boolean(),
  deafened: z.boolean(),
});
export type VoiceMember = z.infer<typeof VoiceMember>;

export const VoiceState = z.object({
  members: z.array(VoiceMember),
  sessionStartedAt: z.number().nullable(),
});
export type VoiceState = z.infer<typeof VoiceState>;

export const RecordingState = z.object({
  active: z.boolean(),
  recordingId: z.uuid().optional(),
  startedBy: z.uuid().optional(),
  startedAt: z.number().optional(),
});
export type RecordingState = z.infer<typeof RecordingState>;

export const ChatMessage = z.object({
  id: z.number().int(),
  userId: z.uuid(),
  body: z.string().min(1).max(LIMITS.messageMaxChars),
  mentions: z.array(z.uuid()),
  at: z.number(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ActivityType = z.enum([
  "voice.join",
  "voice.leave",
  "stream.start",
  "stream.stop",
  "rec.start",
  "rec.stop",
  "member.join",
  "member.kick",
]);
export type ActivityType = z.infer<typeof ActivityType>;

export const ActivityEntry = z.object({
  id: z.number().int(),
  type: ActivityType,
  userId: z.uuid(),
  // App-A pins e.g. `rec.stop meta:{aborted:true}` (boolean) — string|number|boolean values.
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  at: z.number(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

export const UserSettings = z.object({
  notifyAll: z.boolean(),
  notifyMentions: z.boolean(),
  locale: Locale,
  theme: Theme,
});
export type UserSettings = z.infer<typeof UserSettings>;

// The one authoritative localStorage volumes shape (PLAN §5.4); all numbers are gain floats 0..2.
export const VolumesV1 = z.object({
  v: z.literal(1),
  users: z.record(z.string(), z.number()),
  streams: z.record(z.string(), z.number()),
  soundboard: z.number(),
  mutedUsers: z.array(z.string()),
});
export type VolumesV1 = z.infer<typeof VolumesV1>;

// No isAdmin field — clients derive it as adminUserId === self.userId.
export const ServerSummary = z.object({
  id: z.uuid(),
  nickname: z.string(),
  adminUserId: z.uuid(),
  hasPassword: z.boolean(),
  createdAt: z.number(),
  joinedAt: z.number(),
});
export type ServerSummary = z.infer<typeof ServerSummary>;

export const CostStatus = z.object({
  usedGB: z.number(),
  capGB: z.number(),
  blocked: z.boolean(),
});
export type CostStatus = z.infer<typeof CostStatus>;
