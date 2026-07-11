import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, UserProfile, VoiceMember } from "@tavern/shared";

vi.mock("@/features/voice/useVoice", () => ({ useVoice: vi.fn() }));

import { VoiceChannelRow } from "@/features/voice/VoiceChannelRow";
import { useVoice } from "@/features/voice/useVoice";
import { useMediaStore } from "@/stores/media";
import { resetRoomStores, roomStore } from "@/stores/room";

const SID = "s-voice";
const SELF = "11111111-1111-1111-1111-111111111111";
const REMOTE = "22222222-2222-2222-2222-222222222222";

// Base UI positioners use ResizeObserver (absent in jsdom); the AlertDialog stays closed here.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeAll(() => {
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
});

function profile(userId: string): UserProfile {
  return { userId, username: "u", displayName: "Member", color: "#8b5cf6" };
}

function member(userId: string): Member {
  return {
    userId,
    username: "u",
    displayName: "Remote",
    color: "#8b5cf6",
    presence: "in-voice",
    isAdmin: false,
    joinedAt: 1,
  };
}

function seed(voiceMembers: VoiceMember[], members: Member[]): void {
  roomStore(SID)
    .getState()
    .apply({
      t: "hello.ok",
      status: "",
      self: profile(SELF),
      serverMeta: { id: SID, nickname: "cave", adminUserId: SELF },
      members,
      voice: { members: voiceMembers, sessionStartedAt: voiceMembers.length > 0 ? 500 : null },
      streams: [],
      recording: { active: false },
      lastMessageId: null,
      costStatus: { usedGB: 0, capGB: 900, blocked: false },
    });
}

const join = vi.fn(async () => undefined);

function mockVoice(
  over: { status?: "idle" | "joined"; inVoiceServerId?: string | null } = {},
): void {
  vi.mocked(useVoice).mockReturnValue({
    join,
    leave: vi.fn(async () => undefined),
    status: over.status ?? "idle",
    inVoiceServerId: over.inVoiceServerId ?? null,
    muted: false,
    setMuted: vi.fn(),
    deafened: false,
    setDeafened: vi.fn(),
  });
}

beforeEach(() => {
  resetRoomStores();
  useMediaStore.setState({ speakingUserIds: new Set<string>() });
  join.mockClear();
  mockVoice();
});

afterEach(() => {
  cleanup();
});

describe("FR-23 speaking ring", () => {
  it("chip shows ring when userId in speakingUserIds", () => {
    seed([{ userId: REMOTE, muted: false, deafened: false }], [member(REMOTE)]);
    useMediaStore.setState({ speakingUserIds: new Set([REMOTE]) });
    render(<VoiceChannelRow serverId={SID} />);

    const chip = screen.getByTestId(`voice-chip-${REMOTE}`);
    expect(chip.getAttribute("data-speaking")).toBe("true");
  });

  it("chip has no ring when not speaking", () => {
    seed([{ userId: REMOTE, muted: false, deafened: false }], [member(REMOTE)]);
    render(<VoiceChannelRow serverId={SID} />);

    expect(screen.getByTestId(`voice-chip-${REMOTE}`).getAttribute("data-speaking")).toBe("false");
  });
});

describe("FR-18 row click", () => {
  it("click calls join", () => {
    seed([], []);
    render(<VoiceChannelRow serverId={SID} />);

    fireEvent.click(screen.getByTestId("channel-voice"));
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("joined state shows members", () => {
    mockVoice({ status: "joined", inVoiceServerId: SID });
    seed([{ userId: REMOTE, muted: false, deafened: false }], [member(REMOTE)]);
    render(<VoiceChannelRow serverId={SID} />);

    expect(screen.getByTestId(`voice-chip-${REMOTE}`)).toBeTruthy();
  });
});

describe("FR-26 voice status icons", () => {
  it("deafened member shows BOTH can't-talk (mic) and can't-hear (headphones)", () => {
    seed([{ userId: REMOTE, muted: true, deafened: true }], [member(REMOTE)]);
    render(<VoiceChannelRow serverId={SID} />);

    expect(screen.getByTestId(`voice-muted-${REMOTE}`)).toBeTruthy();
    expect(screen.getByTestId(`voice-deafened-${REMOTE}`)).toBeTruthy();
  });

  it("muted-only member shows just the mic icon", () => {
    seed([{ userId: REMOTE, muted: true, deafened: false }], [member(REMOTE)]);
    render(<VoiceChannelRow serverId={SID} />);

    expect(screen.getByTestId(`voice-muted-${REMOTE}`)).toBeTruthy();
    expect(screen.queryByTestId(`voice-deafened-${REMOTE}`)).toBeNull();
  });

  it("unmuted member shows no status icon", () => {
    seed([{ userId: REMOTE, muted: false, deafened: false }], [member(REMOTE)]);
    render(<VoiceChannelRow serverId={SID} />);

    expect(screen.queryByTestId(`voice-muted-${REMOTE}`)).toBeNull();
    expect(screen.queryByTestId(`voice-deafened-${REMOTE}`)).toBeNull();
  });
});

describe("FR-24 session timer on the row", () => {
  it("renders the timer inside the voice row while a session is active", () => {
    // seed() sets sessionStartedAt when there are voice members.
    seed([{ userId: REMOTE, muted: false, deafened: false }], [member(REMOTE)]);
    render(<VoiceChannelRow serverId={SID} />);

    const row = screen.getByTestId("channel-voice");
    expect(row.querySelector('[data-testid="voice-timer"]')).not.toBeNull();
  });

  it("shows no timer when no session is active", () => {
    seed([], []);
    render(<VoiceChannelRow serverId={SID} />);

    expect(screen.queryByTestId("voice-timer")).toBeNull();
  });
});
