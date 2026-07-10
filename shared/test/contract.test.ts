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
  uploaderId: UUID,
  durationMs: 1000,
  trimStartMs: 0,
  trimEndMs: 1000,
  createdAt: 1,
  playCount: 0,
};
const recording = { id: UUID, startedBy: UUID, durationMs: null, startedAt: 1, endedAt: null };

const cases: [string, z.ZodType, unknown][] = [
  [
    "RegisterForm",
    RegisterForm,
    { username: "roman_1", password: "password1", repeatPassword: "password1" },
  ],
  ["LoginForm", LoginForm, { username: "roman_1", password: "x" }],
  ["MeResponse", MeResponse, { user: profile, settings, servers: [summary] }],
  ["PatchProfileRequest", PatchProfileRequest, { displayName: "New" }],
  ["CreateServerRequest", CreateServerRequest, { nickname: "tavern" }],
  ["JoinServerRequest", JoinServerRequest, { nickname: "tavern" }],
  ["PatchServerRequest", PatchServerRequest, { password: null }],
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
  ["SoundsResponse", SoundsResponse, { sounds: [sound] }],
  ["PatchSoundRequest", PatchSoundRequest, { name: "new" }],
  ["Recording", Recording, recording],
  ["RecordingsResponse", RecordingsResponse, { recordings: [recording] }],
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
      tracks: [{ location: "local", mid: "0", trackName: "mic" }],
    },
  ],
  [
    "RtcTracksRemoteRequest",
    RtcTracksRemoteRequest,
    {
      tracks: [
        { location: "remote", sessionId: "s", trackName: "mic", simulcast: { preferredRid: "l" } },
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
  it("ERROR_CODES has 31 unique members", () => {
    expect(ERROR_CODES.length).toBe(31);
    expect(new Set(ERROR_CODES).size).toBe(31);
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
