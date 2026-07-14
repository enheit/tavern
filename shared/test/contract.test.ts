import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ERROR_CODES } from "../src/index";
import {
  RegisterForm,
  LoginForm,
  MeResponse,
  PatchProfileRequest,
  CreateServerRequest,
  JoinServerRequest,
  PatchServerRequest,
  WsTicketRequest,
  WsTicketResponse,
  MembersResponse,
  ActivityPage,
  StatsResponse,
  Sound,
  SoundsResponse,
  PatchSoundRequest,
  Recording,
  RecordingsResponse,
  Screenshot,
  ScreenshotsResponse,
  OpenRecordingResponse,
  UploadPartResponse,
  CompleteRecordingRequest,
  RtcSessionResponse,
  RtcTracksLocalRequest,
  RtcTracksRemoteRequest,
  RtcTracksResponse,
  RtcRenegotiateRequest,
  RtcClosePayload,
  IceServersResponse,
  ApiErrorBody,
  QoeBatchRequest,
  QoeResponse,
  PutStreamPreviewResponse,
  VOICE_AVATAR_EYE_COLORS,
  VOICE_AVATAR_FACIAL_HAIR_STYLES,
  VOICE_AVATAR_GLASSES_STYLES,
  VOICE_AVATAR_HAIR_COLORS,
  VOICE_AVATAR_HAIR_STYLES,
  VOICE_AVATAR_OUTFIT_COLORS,
  VOICE_AVATAR_SKIN_TONES,
  VoiceAvatarConfig,
  VoiceAvatarConfigInput,
} from "../src/index";
import {
  ScreenSourceSchema,
  platformSchema,
  notificationArgSchema,
  updateInfoSchema,
  setBadgeArgSchema,
  setTokenArgSchema,
  selectSourceArgSchema,
} from "../src/index";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const profile = { userId: UUID, username: "roman_1", displayName: "Roman", color: "#a1b2c3" };
const voiceAvatar = {
  version: 2,
  skinTone: "medium",
  hairColor: "ginger",
  hairStyle: "wavy",
  eyeColor: "green",
  glassesStyle: "aviator",
  facialHairStyle: "mustache",
  outfitColor: "#8b5cf6",
} as const;
const settings = { notifyAll: true, notifyMentions: true, locale: "en", theme: "system" };
const summary = {
  id: UUID,
  nickname: "tavern",
  adminUserId: UUID,
  hasPassword: true,
  createdAt: 1,
  joinedAt: 2,
};
const sound = {
  id: UUID,
  name: "horn",
  emoji: "📯",
  gain: 1,
  sourceFileName: "horn.mp3",
  uploaderId: UUID,
  durationMs: 1000,
  trimStartMs: 0,
  trimEndMs: 1000,
  createdAt: 1,
  playCount: 0,
};
const recording = { id: UUID, startedBy: UUID, durationMs: null, startedAt: 1, endedAt: null };
const screenshot = { id: UUID, capturedBy: UUID, createdAt: 1 };

const cases: [string, z.ZodType, unknown][] = [
  [
    "RegisterForm",
    RegisterForm,
    { username: "roman_1", password: "password1", repeatPassword: "password1" },
  ],
  ["LoginForm", LoginForm, { username: "roman_1", password: "x" }],
  ["MeResponse", MeResponse, { user: profile, settings, servers: [summary] }],
  ["PatchProfileRequest", PatchProfileRequest, { displayName: "New" }],
  [
    "CreateServerRequest",
    CreateServerRequest,
    { nickname: "tavern", password: "hunter2", code: "letmein" },
  ],
  ["JoinServerRequest", JoinServerRequest, { nickname: "tavern" }],
  ["PatchServerRequest", PatchServerRequest, { password: "hunter2" }],
  ["WsTicketRequest", WsTicketRequest, { serverId: UUID }],
  ["WsTicketResponse", WsTicketResponse, { ticket: "t" }],
  ["MembersResponse", MembersResponse, { members: [{ ...profile, isAdmin: true, joinedAt: 1 }] }],
  [
    "ActivityPage",
    ActivityPage,
    {
      entries: [{ id: 1, type: "voice.join", userId: UUID, meta: { aborted: true }, at: 1 }],
      hasMore: false,
    },
  ],
  [
    "StatsResponse",
    StatsResponse,
    {
      perUser: [{ userId: UUID, messages: 1, streamSeconds: 2 }],
      watchPairs: [{ viewerId: UUID, streamerId: UUID, seconds: 3 }],
    },
  ],
  ["Sound", Sound, sound],
  ["SoundsResponse", SoundsResponse, { sounds: [sound], hasMore: false }],
  ["PatchSoundRequest", PatchSoundRequest, { name: "new" }],
  ["Recording", Recording, recording],
  ["RecordingsResponse", RecordingsResponse, { recordings: [recording], hasMore: false }],
  ["Screenshot", Screenshot, screenshot],
  ["ScreenshotsResponse", ScreenshotsResponse, { screenshots: [screenshot], hasMore: false }],
  ["OpenRecordingResponse", OpenRecordingResponse, { recordingId: UUID, uploadId: "u" }],
  ["UploadPartResponse", UploadPartResponse, { etag: "e" }],
  [
    "CompleteRecordingRequest",
    CompleteRecordingRequest,
    { parts: [{ partNumber: 1, etag: "e" }], durationMs: 1000 },
  ],
  ["RtcSessionResponse", RtcSessionResponse, { sessionId: "s" }],
  [
    "RtcTracksLocalRequest",
    RtcTracksLocalRequest,
    {
      sessionDescription: { sdp: "x", type: "offer" },
      tracks: [
        {
          location: "local",
          mid: "0",
          trackName: "screen:user:1",
          preset: "1080p60",
          simulcastProfile: "h_i_l_v2",
        },
      ],
    },
  ],
  [
    "RtcTracksRemoteRequest",
    RtcTracksRemoteRequest,
    {
      tracks: [
        { location: "remote", sessionId: "s", trackName: "mic", simulcast: { preferredRid: "i" } },
      ],
    },
  ],
  [
    "RtcTracksResponse",
    RtcTracksResponse,
    { requiresImmediateRenegotiation: true, tracks: [{ trackName: "mic", mid: "0" }] },
  ],
  [
    "RtcRenegotiateRequest",
    RtcRenegotiateRequest,
    { sessionDescription: { sdp: "x", type: "answer" } },
  ],
  ["RtcClosePayload", RtcClosePayload, { tracks: [{ mid: "0" }], force: false }],
  [
    "IceServersResponse",
    IceServersResponse,
    { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] },
  ],
  ["ApiErrorBody", ApiErrorBody, { error: "bad_request" }],
  [
    "PutStreamPreviewResponse",
    PutStreamPreviewResponse,
    { preview: { id: UUID, version: "preview-v1" } },
  ],
  [
    "QoeBatchRequest",
    QoeBatchRequest,
    {
      v: 1,
      samples: [
        {
          role: "viewer",
          platform: "web",
          os: "web",
          streamKind: "screen",
          contentMode: "motion",
          preset: "1080p60",
          codec: "VP9",
          rid: "h",
          limitation: "none",
          health: "healthy",
          targetFps: 60,
          sourceFps: null,
          encodeFps: null,
          receiveFps: 59.5,
          renderFps: 59.2,
          width: 1920,
          height: 1080,
          bitrateKbps: 5800,
          lossPct: 0.1,
          rttMs: 24,
          jitterMs: 2,
          droppedPct: 0.2,
          freezeMs: 0,
          sampleWindowMs: 5000,
        },
      ],
    },
  ],
  ["QoeResponse", QoeResponse, { ok: true }],
  [
    "ScreenSourceSchema",
    ScreenSourceSchema,
    { id: "1", name: "Screen 1", thumbnailDataUrl: "data:," },
  ],
  ["platformSchema", platformSchema, "darwin"],
  ["notificationArgSchema", notificationArgSchema, { title: "t", body: "b", tag: "x" }],
  ["updateInfoSchema", updateInfoSchema, { version: "1.0.0" }],
  ["setBadgeArgSchema", setBadgeArgSchema, 5],
  ["setTokenArgSchema", setTokenArgSchema, "tok"],
  ["selectSourceArgSchema", selectSourceArgSchema, "src-id"],
];

describe("contract surface", () => {
  it("ERROR_CODES has 43 unique members", () => {
    expect(ERROR_CODES.length).toBe(43);
    expect(new Set(ERROR_CODES).size).toBe(43);
  });

  it("CreateServerRequest requires both a password and a non-empty (trimmed) code", () => {
    // Missing code, missing password, and a whitespace-only code (trimmed to empty) all fail.
    expect(CreateServerRequest.safeParse({ nickname: "tavern", password: "hunter2" }).success).toBe(
      false,
    );
    expect(CreateServerRequest.safeParse({ nickname: "tavern", code: "letmein" }).success).toBe(
      false,
    );
    expect(
      CreateServerRequest.safeParse({ nickname: "tavern", password: "hunter2", code: "   " })
        .success,
    ).toBe(false);
  });

  it("PatchServerRequest is password-string-only (clearing with null removed)", () => {
    expect(PatchServerRequest.safeParse({ password: null }).success).toBe(false);
    expect(PatchServerRequest.safeParse({ password: "hunter2" }).success).toBe(true);
  });

  it("voice avatar configs are complete, strict, and clearable only through profile patch", () => {
    expect({
      skinTones: VOICE_AVATAR_SKIN_TONES.length,
      hairColors: VOICE_AVATAR_HAIR_COLORS.length,
      hairStyles: VOICE_AVATAR_HAIR_STYLES.length,
      eyeColors: VOICE_AVATAR_EYE_COLORS.length,
      glassesStyles: VOICE_AVATAR_GLASSES_STYLES.length,
      facialHairStyles: VOICE_AVATAR_FACIAL_HAIR_STYLES.length,
      outfitColors: VOICE_AVATAR_OUTFIT_COLORS.length,
    }).toEqual({
      skinTones: 10,
      hairColors: 12,
      hairStyles: 10,
      eyeColors: 7,
      glassesStyles: 5,
      facialHairStyles: 6,
      outfitColors: 20,
    });
    expect(VoiceAvatarConfig.safeParse(voiceAvatar).success).toBe(true);
    expect(VoiceAvatarConfig.safeParse({ ...voiceAvatar, hairStyle: "mohawk" }).success).toBe(
      false,
    );
    expect(VoiceAvatarConfig.safeParse({ ...voiceAvatar, outfitColor: "violet" }).success).toBe(
      false,
    );
    expect(
      VoiceAvatarConfig.safeParse({
        version: 2,
        skinTone: "medium",
        hairColor: "violet",
        hairStyle: "curly",
        eyeColor: "green",
        glassesStyle: "round",
        outfitColor: "#8b5cf6",
      }).success,
    ).toBe(false);
    expect(VoiceAvatarConfig.safeParse({ ...voiceAvatar, extra: true }).success).toBe(false);
    expect(PatchProfileRequest.safeParse({ voiceAvatar }).success).toBe(true);
    expect(PatchProfileRequest.safeParse({ voiceAvatar: null }).success).toBe(true);
  });

  it("upgrades strict version-one voice avatars at compatibility boundaries", () => {
    const legacy = {
      version: 1,
      skinTone: "deep",
      hairColor: "blonde",
      hairStyle: "bun",
      glasses: true,
      beard: false,
      outfitColor: "#f87171",
    } as const;
    expect(VoiceAvatarConfig.safeParse(legacy).success).toBe(false);
    expect(VoiceAvatarConfigInput.parse(legacy)).toEqual({
      version: 2,
      skinTone: "deep",
      hairColor: "blonde",
      hairStyle: "bun",
      eyeColor: "dark-brown",
      glassesStyle: "round",
      facialHairStyle: "none",
      outfitColor: "#f87171",
    });
    expect(PatchProfileRequest.parse({ voiceAvatar: legacy }).voiceAvatar).toEqual(
      VoiceAvatarConfigInput.parse(legacy),
    );
  });

  it("round-trips a valid fixture through every api.ts + ipc.ts schema", () => {
    for (const [name, schema, fixture] of cases) {
      const r = schema.safeParse(fixture);
      expect(r.success, `${name} should parse: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });

  it("MeResponse uses `user` (not `profile`) and ServerSummary has no isAdmin", () => {
    const parsed = MeResponse.parse({ user: profile, settings, servers: [summary] });
    expect(parsed.user.userId).toBe(UUID);
    const [first] = parsed.servers;
    if (!first) throw new Error("expected a server");
    expect("isAdmin" in first).toBe(false);
    expect(first.adminUserId).toBe(UUID);
  });

  it("nullable/optional variants parse", () => {
    expect(setBadgeArgSchema.safeParse(null).success).toBe(true);
    expect(setTokenArgSchema.safeParse(null).success).toBe(true);
    expect(selectSourceArgSchema.safeParse(null).success).toBe(true);
  });
});
