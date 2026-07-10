import { z } from "zod";
import { LIMITS } from "./limits";
import { errorCodeSchema } from "./errors";
import { UserProfile, UserSettings, ServerSummary, ActivityEntry } from "./domain";

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

export const CreateServerRequest = z.object({
  nickname: z.string().regex(LIMITS.serverNicknameRe),
  password: z.string().min(LIMITS.serverPasswordMinLen).optional(),
});
export type CreateServerRequest = z.infer<typeof CreateServerRequest>;

export const JoinServerRequest = z.object({
  nickname: z.string().regex(LIMITS.serverNicknameRe),
  password: z.string().optional(),
});
export type JoinServerRequest = z.infer<typeof JoinServerRequest>;

export const PatchServerRequest = z
  .object({
    nickname: z.string().regex(LIMITS.serverNicknameRe).optional(),
    password: z.union([z.string().min(LIMITS.serverPasswordMinLen), z.null()]).optional(),
  })
  .refine(atLeastOneKey, { message: "bad_request" });
export type PatchServerRequest = z.infer<typeof PatchServerRequest>;

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
