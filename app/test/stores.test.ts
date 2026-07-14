import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, ServerMessage, UserProfile, VolumesV1 } from "@tavern/shared";
import { VolumesV1 as VolumesV1Schema } from "@tavern/shared";
import type { RoomState } from "@/stores/room";
import { createRoomStore } from "@/stores/room";
import { playUiSound } from "@/lib/uiSounds";
import { useSessionStore } from "@/stores/session";
import {
  DEVICE_SETTINGS_KEY,
  loadDeviceSettings,
  useSettingsStore,
  VOLUMES_STORAGE_KEY,
} from "@/stores/settings";

vi.mock("@/lib/uiSounds", () => ({
  playUiSound: vi.fn(),
  primeUiSounds: vi.fn(() => () => undefined),
}));

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
  status: "",
  self: profile("u1"),
  serverMeta: { id: "sid", nickname: "tavern", adminUserId: "u1" },
  members: [member("u1", { isAdmin: true })],
  voice: { members: [], sessionStartedAt: null },
  streams: [
    { trackName: "screen:u1:1", kind: "screen", userId: "u1", hasAudio: false, preset: "1080p30" },
  ],
  recording: { active: false },
  lastMessageId: 42,
  lastReadMessageId: 0,
  firstUnreadMessageId: null,
  unreadCount: 0,
  costStatus: { usedGB: 0, capGB: 100, blocked: false },
  polls: [],
  points: zeroPoints(),
};

beforeEach(() => {
  vi.mocked(playUiSound).mockClear();
  useSessionStore.setState({
    status: "authed",
    profile: { userId: "u1", username: "alice", displayName: "Alice", color: "#aabbcc" },
  });
});

function zeroPoints() {
  return {
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
}

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
      expect(s.historyInitialized).toBe(false);
      expect(s.streams).toHaveLength(1);
    },
  },
  {
    name: "chat.new",
    frame: {
      t: "chat.new",
      message: { id: 1, userId: "u1", body: "hi", mentions: [], reactions: [], at: 1 },
    },
    check: (s) => {
      expect(s.messages).toHaveLength(1);
      expect(s.messages[0]?.body).toBe("hi");
    },
  },
  {
    name: "chat.page",
    frame: {
      t: "chat.page",
      requestId: "11111111-1111-4111-8111-111111111111",
      mode: "initial",
      messages: [{ id: 2, userId: "u1", body: "older", mentions: [], reactions: [], at: 0 }],
      hasOlder: false,
      hasNewer: false,
    },
    check: (s) => {
      expect(s.messages[0]?.body).toBe("older");
      expect(s.hasOlderHistory).toBe(false);
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
    frame: {
      t: "stream.updated",
      trackName: "screen:u1:1",
      preset: "720p30",
      preview: {
        id: "123e4567-e89b-42d3-a456-426614174000",
        version: "preview-v1",
      },
      at: 1,
    },
    check: (s) => {
      expect(s.streams[0]?.preset).toBe("720p30");
      expect(s.streams[0]?.preview?.version).toBe("preview-v1");
    },
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
    frame: {
      t: "sound.played",
      soundId: "s1",
      byUserId: "u1",
      at: 1,
      trimStartMs: 0,
      trimEndMs: 500,
      gain: 1,
    },
    check: (s) => expect(s.members).toHaveLength(1),
  },
  {
    name: "sound.stopped",
    frame: { t: "sound.stopped", soundId: "s1", byUserId: "u1", at: 1 },
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
  it("covers every server→client frame type exactly once (21 types)", () => {
    expect(new Set(cases.map((c) => c.frame.t)).size).toBe(21);
  });

  for (const c of cases) {
    it(`applies ${c.name}`, () => {
      const store = seededStore();
      store.getState().apply(c.frame);
      c.check(store.getState());
    });
  }
});

describe("chat send sound", () => {
  it("plays the chat-send sound on a valid local send", () => {
    const store = createRoomStore("sid");
    store.getState().sendMessage("hello there");
    expect(vi.mocked(playUiSound)).toHaveBeenCalledWith("chat.send");
  });
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

describe("FR-16 notification-pref hydration", () => {
  it("adopts the server row over the local defaults", () => {
    // Defaults are both on; a user who disabled them on another device must be respected.
    useSettingsStore.setState({ notifyAll: true, notifyMentions: true });
    useSettingsStore.getState().hydrateNotifyPrefs({ notifyAll: false, notifyMentions: true });
    expect(useSettingsStore.getState().notifyAll).toBe(false);
    expect(useSettingsStore.getState().notifyMentions).toBe(true);
  });

  it("re-enables from a server row that turns them back on", () => {
    useSettingsStore.setState({ notifyAll: false, notifyMentions: false });
    useSettingsStore.getState().hydrateNotifyPrefs({ notifyAll: true, notifyMentions: false });
    expect(useSettingsStore.getState().notifyAll).toBe(true);
    expect(useSettingsStore.getState().notifyMentions).toBe(false);
  });
});

// Task-2 (FR-22): the canonical default suppression is DeepFilterNet3. Legacy boolean records and
// garbage land on the default; an explicitly stored mode is always honored.
function seedNoiseSetting(value: unknown): void {
  localStorage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify({ noiseSuppression: value }));
}

describe("FR-22 noise-suppression setting migration", () => {
  it("fresh install (no record) → deepfilter", () => {
    localStorage.removeItem(DEVICE_SETTINGS_KEY);
    expect(loadDeviceSettings().noiseSuppression).toBe("deepfilter");
  });

  it("every stored enum value is kept verbatim", () => {
    for (const mode of ["off", "standard", "deepfilter"]) {
      seedNoiseSetting(mode);
      expect(loadDeviceSettings().noiseSuppression).toBe(mode);
    }
  });

  it("legacy boolean: true → deepfilter (the new canonical 'on'), false → off", () => {
    seedNoiseSetting(true);
    expect(loadDeviceSettings().noiseSuppression).toBe("deepfilter");
    seedNoiseSetting(false);
    expect(loadDeviceSettings().noiseSuppression).toBe("off");
  });

  it("retired 'rnnoise' value → deepfilter", () => {
    seedNoiseSetting("rnnoise");
    expect(loadDeviceSettings().noiseSuppression).toBe("deepfilter");
  });

  it("invalid values → deepfilter; sibling keys survive", () => {
    for (const junk of ["loud", 3, null, { nested: true }]) {
      localStorage.setItem(
        DEVICE_SETTINGS_KEY,
        JSON.stringify({ noiseSuppression: junk, micId: "mic-9" }),
      );
      const settings = loadDeviceSettings();
      expect(settings.noiseSuppression).toBe("deepfilter");
      expect(settings.micId).toBe("mic-9");
    }
  });
});
