import { describe, expect, it } from "vitest";
import type { Member, ServerMessage, UserProfile, VolumesV1 } from "@tavern/shared";
import { VolumesV1 as VolumesV1Schema } from "@tavern/shared";
import type { RoomState } from "@/stores/room";
import { createRoomStore } from "@/stores/room";
import { useSettingsStore, VOLUMES_STORAGE_KEY } from "@/stores/settings";

function profile(userId: string, displayName = "Alice"): UserProfile {
  return { userId, username: "alice", displayName, color: "#aabbcc" };
}

function member(userId: string, over?: Partial<Member>): Member {
  return {
    userId,
    username: "alice",
    displayName: "Alice",
    color: "#aabbcc",
    presence: "online",
    isAdmin: false,
    joinedAt: 1,
    ...over,
  };
}

const baseHello: Extract<ServerMessage, { t: "hello.ok" }> = {
  t: "hello.ok",
  self: profile("u1"),
  serverMeta: { id: "sid", nickname: "tavern", adminUserId: "u1" },
  members: [member("u1", { isAdmin: true })],
  voice: { members: [], sessionStartedAt: null },
  streams: [
    { trackName: "screen:u1:1", kind: "screen", userId: "u1", hasAudio: false, preset: "1080p30" },
  ],
  recording: { active: false },
  lastMessageId: 42,
  costStatus: { usedGB: 0, capGB: 100, blocked: false },
};

// A store seeded with the base snapshot so update/remove reducers have prior state to act on.
function seededStore() {
  const store = createRoomStore("sid");
  store.getState().apply(baseHello);
  return store;
}

interface ReducerCase {
  name: string;
  frame: ServerMessage;
  check: (s: RoomState) => void;
}

const cases: ReducerCase[] = [
  {
    name: "hello.ok",
    frame: baseHello,
    check: (s) => {
      expect(s.members).toHaveLength(1);
      expect(s.serverMeta?.nickname).toBe("tavern");
      expect(s.messages).toHaveLength(0);
      expect(s.hasMoreHistory).toBe(true);
      expect(s.streams).toHaveLength(1);
    },
  },
  {
    name: "chat.new",
    frame: { t: "chat.new", message: { id: 1, userId: "u1", body: "hi", mentions: [], at: 1 } },
    check: (s) => {
      expect(s.messages).toHaveLength(1);
      expect(s.messages[0]?.body).toBe("hi");
    },
  },
  {
    name: "chat.page",
    frame: {
      t: "chat.page",
      messages: [{ id: 2, userId: "u1", body: "older", mentions: [], at: 0 }],
      hasMore: false,
    },
    check: (s) => {
      expect(s.messages[0]?.body).toBe("older");
      expect(s.hasMoreHistory).toBe(false);
    },
  },
  {
    name: "presence.update",
    frame: { t: "presence.update", userId: "u1", presence: "in-voice", at: 1 },
    check: (s) => expect(s.members[0]?.presence).toBe("in-voice"),
  },
  {
    name: "member.update",
    frame: { t: "member.update", profile: profile("u1", "Renamed"), at: 1 },
    check: (s) => expect(s.members[0]?.displayName).toBe("Renamed"),
  },
  {
    name: "member.joined",
    frame: { t: "member.joined", member: member("u2"), at: 1 },
    check: (s) => expect(s.members).toHaveLength(2),
  },
  {
    name: "member.left",
    frame: { t: "member.left", userId: "u1", at: 1 },
    check: (s) => expect(s.members).toHaveLength(0),
  },
  {
    name: "voice.state",
    frame: {
      t: "voice.state",
      voice: { members: [{ userId: "u1", muted: true, deafened: false }], sessionStartedAt: 5 },
      at: 1,
    },
    check: (s) => {
      expect(s.voice.members).toHaveLength(1);
      expect(s.voice.sessionStartedAt).toBe(5);
    },
  },
  {
    name: "stream.added",
    frame: {
      t: "stream.added",
      stream: {
        trackName: "cam:u1",
        kind: "webcam",
        userId: "u1",
        hasAudio: false,
        preset: "720p30",
      },
      at: 1,
    },
    check: (s) => expect(s.streams).toHaveLength(2),
  },
  {
    name: "stream.updated",
    frame: { t: "stream.updated", trackName: "screen:u1:1", preset: "720p30", at: 1 },
    check: (s) => expect(s.streams[0]?.preset).toBe("720p30"),
  },
  {
    name: "stream.removed",
    frame: { t: "stream.removed", trackName: "screen:u1:1", at: 1 },
    check: (s) => expect(s.streams).toHaveLength(0),
  },
  {
    name: "activity.new",
    frame: {
      t: "activity.new",
      entry: { id: 1, type: "voice.join", userId: "u1", meta: {}, at: 1 },
    },
    check: (s) => expect(s.activityTail).toHaveLength(1),
  },
  {
    name: "rec.state",
    frame: {
      t: "rec.state",
      recording: { active: true, recordingId: "r1", startedBy: "u1", startedAt: 1 },
      at: 1,
    },
    check: (s) => expect(s.recording.active).toBe(true),
  },
  {
    name: "server.updated",
    frame: { t: "server.updated", nickname: "Renamed", at: 1 },
    check: (s) => expect(s.serverMeta?.nickname).toBe("Renamed"),
  },
  {
    name: "kicked",
    frame: { t: "kicked", at: 1 },
    check: (s) => expect(s.kicked).toBe(true),
  },
  {
    name: "error",
    frame: { t: "error", code: "bad_message" },
    check: (s) => expect(s.members).toHaveLength(1),
  },
  {
    name: "pong",
    frame: { t: "pong" },
    check: (s) => expect(s.members).toHaveLength(1),
  },
  {
    name: "sound.played",
    frame: { t: "sound.played", soundId: "s1", byUserId: "u1", at: 1 },
    check: (s) => expect(s.members).toHaveLength(1),
  },
  {
    name: "sound.updated",
    frame: { t: "sound.updated", at: 1 },
    check: (s) => expect(s.members).toHaveLength(1),
  },
  {
    name: "cost.warning",
    frame: { t: "cost.warning", usedGB: 1, capGB: 2, at: 1 },
    check: (s) => expect(s.members).toHaveLength(1),
  },
];

describe("§App-A room reducer", () => {
  it("covers every server→client frame type exactly once (20 types)", () => {
    expect(new Set(cases.map((c) => c.frame.t)).size).toBe(20);
  });

  for (const c of cases) {
    it(`applies ${c.name}`, () => {
      const store = seededStore();
      store.getState().apply(c.frame);
      c.check(store.getState());
    });
  }
});

describe("§5.4 volumes persistence", () => {
  it("round-trips through localStorage and validates VolumesV1", () => {
    const sample: VolumesV1 = {
      v: 1,
      users: { u1: 1.5 },
      streams: { "screen:u1:1": 0.5 },
      soundboard: 1.2,
      mutedUsers: ["u2"],
    };
    useSettingsStore.getState().setVolumes(sample);

    const raw = localStorage.getItem(VOLUMES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = VolumesV1Schema.parse(JSON.parse(raw ?? "null"));
    expect(parsed).toEqual(sample);
    expect(useSettingsStore.getState().volumes).toEqual(sample);
  });
});
