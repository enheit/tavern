import { describe, it, expect } from "vitest";
import { parseClientMessage, parseServerMessage } from "../src/protocol";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const track = `screen:${UUID}:1`;

const profile = { userId: UUID, username: "roman_1", displayName: "Roman", color: "#a1b2c3" };
const member = { ...profile, presence: "online", isAdmin: true, joinedAt: 1 };
const voice = { members: [], sessionStartedAt: null };
const recording = { active: false };
const cost = { usedGB: 0, capGB: 1000, blocked: false };
const points = {
  balance: 0,
  pendingPollWinnings: 0,
  currentRatePerMinute: 0,
  activeSources: [],
  today: { day: "2026-07-13", conversation: 0, streaming: 0, watching: 0, total: 0 },
  config: {
    enabled: true,
    basePointsPerMinute: 5,
    streamerBonusPerMinute: 5,
    watcherBonusPerMinute: 5,
    dailyCap: null,
  },
};
const poll = {
  id: UUID,
  creatorId: UUID,
  creatorDisplayName: "Roman",
  question: "Who wins?",
  outcomes: [
    { id: "223e4567-e89b-42d3-a456-426614174000", title: "Blue", totalPoints: 0, bidderCount: 0 },
    { id: "323e4567-e89b-42d3-a456-426614174000", title: "Red", totalPoints: 0, bidderCount: 0 },
  ],
  status: "open",
  createdAt: 1,
  closesAt: 60_001,
  lockedAt: null,
  resolvedAt: null,
  finalizesAt: null,
  finalizedAt: null,
  voidedAt: null,
  winningOutcomeId: null,
  correctionUsed: false,
  resultVisibleUntil: null,
  totalPool: 0,
  myBid: null,
};
const chatMsg = { id: 1, userId: UUID, body: "hi", mentions: [], reactions: [], at: 1 };
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
  { t: "chat.history", requestId: UUID, mode: "initial", limit: 30 },
  { t: "chat.read", messageId: 1 },
  { t: "chat.edit", requestId: UUID, messageId: 1, body: "updated" },
  { t: "chat.delete", requestId: UUID, messageId: 1 },
  { t: "chat.reaction.set", requestId: UUID, messageId: 1, emoji: "😀", reacted: true },
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
  { t: "status.set", text: "brb in 5" },
  {
    t: "poll.create",
    requestId: UUID,
    question: "Who wins?",
    outcomes: ["Blue", "Red"],
    durationSeconds: 120,
  },
  { t: "poll.bid", requestId: UUID, pollId: UUID, outcomeId: UUID, stake: 10 },
  { t: "poll.lock", requestId: UUID, pollId: UUID },
  { t: "poll.resolve", requestId: UUID, pollId: UUID, outcomeId: UUID },
  { t: "poll.correct", requestId: UUID, pollId: UUID, outcomeId: UUID },
  { t: "poll.void", requestId: UUID, pollId: UUID },
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
    status: "",
    lastMessageId: null,
    lastReadMessageId: 0,
    firstUnreadMessageId: null,
    unreadCount: 0,
    costStatus: cost,
    points,
    polls: [poll],
  },
  { t: "error", code: "bad_message" },
  { t: "pong" },
  { t: "chat.new", message: chatMsg },
  {
    t: "chat.page",
    requestId: UUID,
    mode: "initial",
    messages: [chatMsg],
    hasOlder: false,
    hasNewer: false,
  },
  { t: "chat.updated", message: { ...chatMsg, editedAt: 2 } },
  { t: "chat.deleted", message: { ...chatMsg, body: "", deletedAt: 2 } },
  {
    t: "chat.read-state",
    lastReadMessageId: 1,
    firstUnreadMessageId: null,
    unreadCount: 0,
  },
  {
    t: "chat.reaction.updated",
    messageId: 1,
    emoji: "😀",
    reaction: { emoji: "😀", reactors: [{ userId: UUID, displayName: "Roman" }] },
  },
  { t: "activity.new", entry: activityEntry },
  { t: "hangout.updated", at: 1 },
  { t: "presence.update", userId: UUID, presence: "online", at: 1 },
  { t: "member.update", profile, at: 1 },
  { t: "member.joined", member, at: 1 },
  { t: "member.left", userId: UUID, at: 1 },
  { t: "voice.state", voice, at: 1 },
  { t: "stream.added", stream: streamInfo, at: 1 },
  { t: "stream.updated", trackName: track, preset: "720p30", at: 1 },
  { t: "stream.removed", trackName: track, at: 1 },
  { t: "sound.played", soundId: UUID, byUserId: UUID, at: 1, trimStartMs: 0, trimEndMs: 1500 },
  { t: "sound.updated", at: 1 },
  { t: "rec.state", recording, at: 1 },
  { t: "server.updated", nickname: "tavern", at: 1 },
  { t: "status.updated", text: "brb in 5", at: 1 },
  { t: "kicked", at: 1 },
  { t: "cost.warning", usedGB: 1, capGB: 2, at: 1 },
  { t: "points.updated", points, at: 1 },
  { t: "poll.updated", poll, at: 1 },
];

describe("App-A protocol round-trips", () => {
  it("parses all client message fixtures", () => {
    expect(clientFixtures.length).toBe(26);
    for (const f of clientFixtures) {
      expect(() => parseClientMessage(f)).not.toThrow();
    }
  });

  it("parses all server message fixtures", () => {
    expect(serverFixtures.length).toBe(28);
    for (const f of serverFixtures) {
      expect(() => parseServerMessage(f)).not.toThrow();
    }
  });

  it("rejects invalid frames", () => {
    expect(() => parseClientMessage({ t: "nope" })).toThrow();
    expect(() =>
      parseClientMessage({ t: "chat.send", body: "x".repeat(2001), nonce: UUID }),
    ).toThrow();
    expect(() =>
      parseClientMessage({ t: "chat.history", requestId: UUID, mode: "initial", limit: 31 }),
    ).toThrow();
    expect(() =>
      parseClientMessage({ t: "stream.start", kind: "screen", trackName: "x", preset: "999p99" }),
    ).toThrow();
    expect(() => parseClientMessage({ t: "hello", proto: 2 })).toThrow();
    expect(() =>
      parseClientMessage({
        t: "chat.reaction.set",
        requestId: UUID,
        messageId: 1,
        emoji: "not emoji",
        reacted: true,
      }),
    ).toThrow();
    expect(() =>
      parseClientMessage({
        t: "chat.reaction.set",
        requestId: UUID,
        messageId: 1,
        emoji: "😀😄",
        reacted: true,
      }),
    ).toThrow();
    expect(() => parseServerMessage({ t: "error", code: "not_a_real_code" })).toThrow();
  });

  it("defaults reactions for an older chat message frame", () => {
    const parsed = parseServerMessage({
      t: "chat.new",
      message: { id: 1, userId: UUID, body: "hi", mentions: [], at: 1 },
    });
    if (parsed.t !== "chat.new") throw new Error("expected chat.new");
    expect(parsed.message.reactions).toEqual([]);
  });
});
