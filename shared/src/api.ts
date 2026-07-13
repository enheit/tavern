import { z } from "zod";
import { LIMITS } from "./limits";
import { errorCodeSchema } from "./errors";
import {
  UserProfile,
  UserSettings,
  ServerSummary,
  ActivityEntry,
  GifAttachment,
  PointConfig,
  Poll,
  PollParticipantResult,
} from "./domain";

const atLeastOneKey = (o: object) => Object.keys(o).length >= 1;

export const RegisterForm = z
  .object({
    username: z.string().regex(LIMITS.usernameRe),
    password: z.string().min(LIMITS.passwordMinLen),
    repeatPassword: z.string(),
  })
  .refine((o) => o.password === o.repeatPassword, {
    message: "password_mismatch",
    path: ["repeatPassword"],
  });
export type RegisterForm = z.infer<typeof RegisterForm>;

export const LoginForm = z.object({ username: z.string(), password: z.string() });
export type LoginForm = z.infer<typeof LoginForm>;

export const MeResponse = z.object({
  user: UserProfile,
  settings: UserSettings,
  servers: z.array(ServerSummary),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const PatchProfileRequest = z
  .object({
    displayName: z.string().min(LIMITS.displayNameMin).max(LIMITS.displayNameMax).optional(),
    color: z.string().regex(LIMITS.colorRe).optional(),
    username: z.string().regex(LIMITS.usernameRe).optional(),
  })
  .refine(atLeastOneKey, { message: "bad_request" });
export type PatchProfileRequest = z.infer<typeof PatchProfileRequest>;

// Password is ALWAYS required (no open servers) and `code` is a one-time server-creation code an
// operator seeds into D1 by hand (uncontrolled resource creation guard). The worker burns the code
// atomically on success and records who used it, when, and for which server.
export const CreateServerRequest = z.object({
  nickname: z.string().regex(LIMITS.serverNicknameRe),
  password: z.string().min(LIMITS.serverPasswordMinLen),
  code: z.string().trim().min(1),
});
export type CreateServerRequest = z.infer<typeof CreateServerRequest>;

export const JoinServerRequest = z.object({
  nickname: z.string().regex(LIMITS.serverNicknameRe),
  password: z.string().optional(),
});
export type JoinServerRequest = z.infer<typeof JoinServerRequest>;

// `password` can only be REPLACED, never cleared — a server password is always set (no open
// servers), matching CreateServerRequest.
export const PatchServerRequest = z
  .object({
    nickname: z.string().regex(LIMITS.serverNicknameRe).optional(),
    password: z.string().min(LIMITS.serverPasswordMinLen).optional(),
  })
  .refine(atLeastOneKey, { message: "bad_request" });
export type PatchServerRequest = z.infer<typeof PatchServerRequest>;

export const PutPointConfigRequest = PointConfig;
export type PutPointConfigRequest = z.infer<typeof PutPointConfigRequest>;

export const PollDetail = Poll.extend({ participants: z.array(PollParticipantResult) });
export type PollDetail = z.infer<typeof PollDetail>;

export const PollPage = z.object({
  polls: z.array(PollDetail),
  hasMore: z.boolean(),
});
export type PollPage = z.infer<typeof PollPage>;

export const WsTicketRequest = z.object({ serverId: z.uuid() });
export type WsTicketRequest = z.infer<typeof WsTicketRequest>;

export const WsTicketResponse = z.object({ ticket: z.string() });
export type WsTicketResponse = z.infer<typeof WsTicketResponse>;

export const MembersResponse = z.object({
  members: z.array(UserProfile.extend({ isAdmin: z.boolean(), joinedAt: z.number() })),
});
export type MembersResponse = z.infer<typeof MembersResponse>;

export const ActivityPage = z.object({ entries: z.array(ActivityEntry), hasMore: z.boolean() });
export type ActivityPage = z.infer<typeof ActivityPage>;

export const StatsResponse = z.object({
  perUser: z.array(
    z.object({ userId: z.uuid(), messages: z.number().int(), streamSeconds: z.number().int() }),
  ),
  watchPairs: z.array(
    z.object({ viewerId: z.uuid(), streamerId: z.uuid(), seconds: z.number().int() }),
  ),
});
export type StatsResponse = z.infer<typeof StatsResponse>;

export const Sound = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(LIMITS.soundNameMax),
  uploaderId: z.uuid(),
  durationMs: z.number().int(),
  trimStartMs: z.number().int(),
  trimEndMs: z.number().int(),
  createdAt: z.number(),
  playCount: z.number().int(),
});
export type Sound = z.infer<typeof Sound>;

export const SoundsResponse = z.object({ sounds: z.array(Sound) });
export type SoundsResponse = z.infer<typeof SoundsResponse>;

export const PatchSoundRequest = z
  .object({
    name: z.string().min(1).max(LIMITS.soundNameMax).optional(),
    trimStartMs: z.number().int().optional(),
    trimEndMs: z.number().int().optional(),
  })
  .refine(atLeastOneKey, { message: "bad_request" });
export type PatchSoundRequest = z.infer<typeof PatchSoundRequest>;

export const Recording = z.object({
  id: z.uuid(),
  startedBy: z.uuid(),
  durationMs: z.number().int().nullable(),
  startedAt: z.number(),
  endedAt: z.number().int().nullable(),
});
export type Recording = z.infer<typeof Recording>;

export const RecordingsResponse = z.object({ recordings: z.array(Recording) });
export type RecordingsResponse = z.infer<typeof RecordingsResponse>;

// A stream screenshot (§ screenshots tab): a single still frame a member captured from the focused
// stream, stored in R2 under `{serverId}/screenshots/{id}.webp`. The row records who captured it and
// when (the image bytes themselves are served by the public capability route keyed by the two UUIDs).
export const Screenshot = z.object({
  id: z.uuid(),
  capturedBy: z.uuid(),
  createdAt: z.number(),
});
export type Screenshot = z.infer<typeof Screenshot>;

export const ScreenshotsResponse = z.object({ screenshots: z.array(Screenshot) });
export type ScreenshotsResponse = z.infer<typeof ScreenshotsResponse>;

// The idle-center Tavern Home is a bounded social recap, not an audit log. Hangouts are derived from
// exact voice-presence overlap; `sharedDurationMs` excludes solo time and reconnect gaps.
export const HangoutSummary = z.object({
  id: z.number().int().positive(),
  participantIds: z.array(z.uuid()).min(2),
  startedAt: z.number(),
  endedAt: z.number(),
  sharedDurationMs: z.number().int().nonnegative(),
});
export type HangoutSummary = z.infer<typeof HangoutSummary>;

export const PointLeaderboardEntry = z.object({
  userId: z.uuid(),
  balance: z.number().int().nonnegative(),
});
export type PointLeaderboardEntry = z.infer<typeof PointLeaderboardEntry>;

export const TavernHomeResponse = z.object({
  recentHangouts: z.array(HangoutSummary),
  pointLeaderboard: z.array(PointLeaderboardEntry),
  latestScreenshot: Screenshot.nullable(),
  latestRecording: Recording.nullable(),
  latestSound: Sound.nullable(),
});
export type TavernHomeResponse = z.infer<typeof TavernHomeResponse>;

// GET /api/gifs/search — the Worker proxies a GIF provider (Klipy) and returns THIS normalized shape
// so the client never couples to a specific vendor's JSON (swapping providers stays worker-only). A
// result is a `GifAttachment` (the exact struct persisted on a message) plus the provider's item id.
// `next` is an opaque pagination cursor to pass back as `?pos=`; null when there is no further page.
export const GifResult = GifAttachment.extend({ id: z.string() });
export type GifResult = z.infer<typeof GifResult>;

export const GifSearchResponse = z.object({
  results: z.array(GifResult),
  next: z.string().nullable(),
});
export type GifSearchResponse = z.infer<typeof GifSearchResponse>;

// POST /api/servers/:id/screenshots returns the freshly-created row (the tab also refetches on the
// `screenshot.updated` broadcast, but the capturer's own upload resolves with the row immediately).
export const CreateScreenshotResponse = z.object({ screenshot: Screenshot });
export type CreateScreenshotResponse = z.infer<typeof CreateScreenshotResponse>;

// POST /api/servers/:id/chat-images (§ chat image paste): the Worker streams the pasted webp to R2 and
// returns the freshly-minted image id. The client then sends `chat.send` with an `ImageAttachment`
// carrying this id; the message renderer builds the public capability URL from it.
export const CreateChatImageResponse = z.object({ id: z.uuid() });
export type CreateChatImageResponse = z.infer<typeof CreateChatImageResponse>;

// POST /api/servers/:id/chat-images/from-url (§ chat image paste, drag-from-web path): the client drops
// an image that only carried a URL (a cross-app browser drag that delivered no file bytes). Rather than
// have the BROWSER fetch it (cross-origin → CORS/hotlink), the WORKER fetches the bytes server-side and
// stores them in R2, returning the id. `width`/`height` are measured client-side by loading the URL in
// an `<img>` (a CORS-exempt image load) so the attachment still gets an aspect-ratio box.
export const ChatImageFromUrlRequest = z.object({
  url: z.url().max(2048),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
});
export type ChatImageFromUrlRequest = z.infer<typeof ChatImageFromUrlRequest>;

export const OpenRecordingResponse = z.object({ recordingId: z.uuid(), uploadId: z.string() });
export type OpenRecordingResponse = z.infer<typeof OpenRecordingResponse>;

export const UploadPartResponse = z.object({ etag: z.string() });
export type UploadPartResponse = z.infer<typeof UploadPartResponse>;

export const CompleteRecordingRequest = z.object({
  parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string() })),
  durationMs: z.number().int(),
});
export type CompleteRecordingRequest = z.infer<typeof CompleteRecordingRequest>;

export const RtcSessionResponse = z.object({ sessionId: z.string() });
export type RtcSessionResponse = z.infer<typeof RtcSessionResponse>;

export const RtcTracksLocalRequest = z.object({
  sessionDescription: z.object({ sdp: z.string(), type: z.literal("offer") }),
  tracks: z.array(
    z.object({ location: z.literal("local"), mid: z.string(), trackName: z.string() }),
  ),
});
export type RtcTracksLocalRequest = z.infer<typeof RtcTracksLocalRequest>;

export const RtcTracksRemoteRequest = z.object({
  tracks: z.array(
    z.object({
      location: z.literal("remote"),
      sessionId: z.string(),
      trackName: z.string(),
      simulcast: z.object({ preferredRid: z.enum(["h", "l"]) }).optional(),
    }),
  ),
});
export type RtcTracksRemoteRequest = z.infer<typeof RtcTracksRemoteRequest>;

export const RtcTracksResponse = z.object({
  requiresImmediateRenegotiation: z.boolean(),
  tracks: z.array(
    z.object({
      trackName: z.string(),
      mid: z.string().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
  sessionDescription: z.object({ sdp: z.string(), type: z.enum(["answer", "offer"]) }).optional(),
});
export type RtcTracksResponse = z.infer<typeof RtcTracksResponse>;

export const RtcRenegotiateRequest = z.object({
  sessionDescription: z.object({ sdp: z.string(), type: z.literal("answer") }),
});
export type RtcRenegotiateRequest = z.infer<typeof RtcRenegotiateRequest>;

export const RtcClosePayload = z.object({
  tracks: z.array(z.object({ mid: z.string() })),
  sessionDescription: z.object({ sdp: z.string(), type: z.literal("offer") }).optional(),
  force: z.boolean(),
});
export type RtcClosePayload = z.infer<typeof RtcClosePayload>;

export const IceServersResponse = z.object({
  iceServers: z.array(
    z.object({
      urls: z.union([z.string(), z.array(z.string())]),
      username: z.string().optional(),
      credential: z.string().optional(),
    }),
  ),
});
export type IceServersResponse = z.infer<typeof IceServersResponse>;

export const ApiErrorBody = z.object({ error: errorCodeSchema });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
