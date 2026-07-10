import { describe, it, expect } from "vitest";
import { parseClientMessage, parseServerMessage } from "../src/protocol";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const track = `screen:${UUID}:1`;

const profile = { userId: UUID, username: "roman_1", displayName: "Roman", color: "#a1b2c3" };
const member = { ...profile, presence: "online", isAdmin: true, joinedAt: 1 };
const voice = { members: [], sessionStartedAt: null };
const recording = { active: false };
const cost = { usedGB: 0, capGB: 1000, blocked: false };
const chatMsg = { id: 1, userId: UUID, body: "hi", mentions: [], at: 1 };
const activityEntry = { id: 1, type: "voice.join", userId: UUID, meta: {}, at: 1 };
const streamInfo = {
  trackName: track,
  kind: "screen",
  userId: UUID,
  hasAudio: true,
  preset: "1080p30",
};

const clientFixtures = [
  { t: "hello", proto: 1 },
  { t: "chat.send", body: "hi", nonce: UUID },
  { t: "chat.history", limit: 50 },
  { t: "voice.join" },
  { t: "voice.leave" },
  { t: "voice.state", muted: false, deafened: false },
  { t: "stream.start", kind: "screen", trackName: track, preset: "1080p30" },
  { t: "stream.preset", trackName: track, preset: "720p30" },
  { t: "stream.stop", trackName: track },
  { t: "watch.start", trackName: track },
  { t: "watch.stop", trackName: track },
  { t: "sound.play", soundId: UUID },
  { t: "rec.start" },
  { t: "rec.stop" },
  { t: "ping" },
];

const serverFixtures = [
  {
    t: "hello.ok",
    self: profile,
    serverMeta: { id: UUID, nickname: "tavern", adminUserId: UUID },
    members: [member],
    voice,
    streams: [streamInfo],
    recording,
    lastMessageId: null,
    costStatus: cost,
  },
  { t: "error", code: "bad_message" },
  { t: "pong" },
  { t: "chat.new", message: chatMsg },
  { t: "chat.page", messages: [chatMsg], hasMore: false },
  { t: "activity.new", entry: activityEntry },
  { t: "presence.update", userId: UUID, presence: "online", at: 1 },
  { t: "member.update", profile, at: 1 },
  { t: "member.joined", member, at: 1 },
  { t: "member.left", userId: UUID, at: 1 },
  { t: "voice.state", voice, at: 1 },
  { t: "stream.added", stream: streamInfo, at: 1 },
  { t: "stream.updated", trackName: track, preset: "720p30", at: 1 },
  { t: "stream.removed", trackName: track, at: 1 },
  { t: "sound.played", soundId: UUID, byUserId: UUID, at: 1 },
  { t: "sound.updated", at: 1 },
  { t: "rec.state", recording, at: 1 },
  { t: "server.updated", nickname: "tavern", at: 1 },
  { t: "kicked", at: 1 },
  { t: "cost.warning", usedGB: 1, capGB: 2, at: 1 },
];

describe("App-A protocol round-trips", () => {
  it("parses all 15 client message fixtures", () => {
    expect(clientFixtures.length).toBe(15);
    for (const f of clientFixtures) {
      expect(() => parseClientMessage(f)).not.toThrow();
    }
  });

  it("parses all 20 server message fixtures", () => {
    expect(serverFixtures.length).toBe(20);
    for (const f of serverFixtures) {
      expect(() => parseServerMessage(f)).not.toThrow();
    }
  });

  it("rejects invalid frames", () => {
    expect(() => parseClientMessage({ t: "nope" })).toThrow();
    expect(() =>
      parseClientMessage({ t: "chat.send", body: "x".repeat(2001), nonce: UUID }),
    ).toThrow();
    expect(() => parseClientMessage({ t: "chat.history", limit: 51 })).toThrow();
    expect(() =>
      parseClientMessage({ t: "stream.start", kind: "screen", trackName: "x", preset: "999p99" }),
    ).toThrow();
    expect(() => parseClientMessage({ t: "hello", proto: 2 })).toThrow();
    expect(() => parseServerMessage({ t: "error", code: "not_a_real_code" })).toThrow();
  });
});
