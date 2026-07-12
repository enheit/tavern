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
  // Bumped by the DO each time this member's mic track (re)registers on a publish (a rejoin or a
  // transport recovery creates a NEW SFU session under the SAME mic:{uid} name — invisible in the
  // roster otherwise). Peers re-pull when it changes; absent (old worker) reads as 0. Additive:
  // clients on the previous schema strip the key on parse.
  micSeq: z.number().int().nonnegative().optional(),
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

// A GIF attachment on a chat message (§ GIF picker). `url` is the animated media (GIF) shown inline,
// `previewUrl` a smaller variant used in the picker grid; the dimensions drive a fixed aspect-ratio
// box so the row does not reflow once the image loads. Always provider-sourced via the Worker GIF
// proxy (normalized, never user free-text), so the URLs are trusted CDN links.
export const GifAttachment = z.object({
  url: z.url().max(2048),
  previewUrl: z.url().max(2048),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
});
export type GifAttachment = z.infer<typeof GifAttachment>;

// An image attachment on a chat message (§ chat image paste). Unlike a GIF (a trusted provider URL),
// this image lives in OUR R2 and is referenced by an opaque `id` only — never a client-supplied URL,
// so a client can never inject an off-origin `src`. The bytes are served by the public capability
// route `/api/chat-images/{serverId}/{id}.webp`; the RENDERER builds that URL from the active server
// + this id, so the id is meaningful only within the server it was uploaded to (no cross-server leak).
// `width`/`height` are the stored (post-downscale) pixel dimensions, driving a fixed aspect-ratio box
// so the row does not reflow once the image loads.
export const ImageAttachment = z.object({
  id: z.uuid(),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

export const ChatMessage = z.object({
  id: z.number().int(),
  userId: z.uuid(),
  // Empty allowed only alongside a `gif` or `image` (a pure-attachment message carries no text); the
  // DO re-checks the "body non-empty OR gif OR image present" invariant on send. `.min(1)` is
  // intentionally dropped here.
  body: z.string().max(LIMITS.messageMaxChars),
  mentions: z.array(z.uuid()),
  at: z.number(),
  gif: GifAttachment.optional(),
  image: ImageAttachment.optional(),
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
