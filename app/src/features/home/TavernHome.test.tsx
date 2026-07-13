import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, TavernHomeResponse } from "@tavern/shared";
import { TavernHome } from "./TavernHome";
import { resetRoomStores, roomStore } from "@/stores/room";

const getMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/apiClient", () => ({ apiClient: { get: getMock } }));

const onMock = vi.hoisted(() => vi.fn((_event: string, _callback: () => void) => () => {}));
vi.mock("@/lib/wsClient", () => ({ connectRoom: () => ({ on: onMock }) }));

vi.mock("@/features/recordings/RecordingPlayer", () => ({
  RecordingPlayer: ({ recordingId }: { recordingId: string }) => (
    <div data-testid={`recording-player-${recordingId}`} />
  ),
}));

const SERVER_ID = "3d4652b7-c943-4d0e-9d3c-746468d6e4ba";
const A_ID = "15591ec7-e192-4059-934e-a37b897e4d79";
const B_ID = "85174d13-71a7-490f-98fc-596029c205f8";
const C_ID = "4bfce402-f4b1-4ed9-b236-8242a3b4a429";
const D_ID = "76bdb130-dd3c-4015-b3e0-4886fd99d07d";
const SHOT_ID = "40706fa8-28d1-475e-9286-142f9810a520";
const REC_ID = "cb8c4ce5-3f0b-47aa-bccc-91092738fd25";
const SOUND_ID = "8dd94a80-994f-47f8-813b-3ef2e2677f5f";
const T0 = 1_700_000_000_000;

const members: Member[] = [
  {
    userId: A_ID,
    username: "roman",
    displayName: "Roman",
    color: "#ff8800",
    presence: "in-voice",
    isAdmin: true,
    joinedAt: T0,
  },
  {
    userId: D_ID,
    username: "ivan",
    displayName: "Ivan",
    color: "#9966cc",
    presence: "offline",
    isAdmin: false,
    joinedAt: T0,
  },
  {
    userId: C_ID,
    username: "marta",
    displayName: "Marta",
    color: "#44aa77",
    presence: "offline",
    isAdmin: false,
    joinedAt: T0,
  },
  {
    userId: B_ID,
    username: "oleh",
    displayName: "Oleh",
    color: "#5588ff",
    presence: "in-voice",
    isAdmin: false,
    joinedAt: T0,
  },
];

const response: TavernHomeResponse = {
  recentHangouts: [
    {
      id: 1,
      participantIds: [A_ID, B_ID],
      startedAt: T0,
      endedAt: T0 + 300_000,
      sharedDurationMs: 300_000,
    },
  ],
  pointLeaderboard: [
    { userId: B_ID, balance: 300 },
    { userId: A_ID, balance: 120 },
    { userId: C_ID, balance: 40 },
    { userId: D_ID, balance: 0 },
  ],
  latestScreenshot: { id: SHOT_ID, capturedBy: A_ID, createdAt: T0 + 400_000 },
  latestRecording: {
    id: REC_ID,
    startedBy: B_ID,
    durationMs: 60_000,
    startedAt: T0 + 500_000,
    endedAt: T0 + 560_000,
  },
  latestSound: {
    id: SOUND_ID,
    name: "cheers",
    uploaderId: A_ID,
    durationMs: 1_000,
    trimStartMs: 0,
    trimEndMs: 1_000,
    createdAt: T0 + 600_000,
    playCount: 4,
  },
};

function renderHome(onOpenSoundboard = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onOpenSoundboard,
    ...render(
      <QueryClientProvider client={queryClient}>
        <TavernHome serverId={SERVER_ID} onOpenSoundboard={onOpenSoundboard} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  resetRoomStores();
  getMock.mockResolvedValue(response);
  onMock.mockClear();
  roomStore(SERVER_ID).setState({
    members,
    voice: {
      members: members
        .filter((member) => member.presence === "in-voice")
        .map((member) => ({ userId: member.userId, muted: false, deafened: false })),
      sessionStartedAt: T0,
    },
  });
});

afterEach(() => cleanup());

describe("Tavern Home", () => {
  it("renders live presence, member availability, hangouts, and each media type", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByTestId("home-hangout-1")).toBeDefined());

    expect(screen.getByText("Roman, Oleh hung out")).toBeDefined();
    expect(screen.getByTestId("home-live-avatars").children).toHaveLength(2);
    expect(screen.getByTestId("home-latest-screenshot")).toBeDefined();
    expect(screen.getByTestId(`recording-player-${REC_ID}`)).toBeDefined();
    expect(screen.getByText("cheers")).toBeDefined();
    expect(screen.getByTestId("home-members-online").textContent).toContain("Roman");
    expect(screen.getByTestId("home-members-online").textContent).toContain("Oleh");
    expect(screen.getByTestId("home-members-offline").textContent).toContain("Marta");
    expect(
      [...screen.getByTestId("home-points-leaderboard").children].map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Oleh300"),
      expect.stringContaining("Roman120"),
      expect.stringContaining("Marta40"),
      expect.stringContaining("Ivan0"),
    ]);
    expect(screen.getByTestId("home-rank-1").querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("home-rank-2").querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("home-rank-3").querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("home-rank-4").textContent).toBe("4");
    expect(screen.queryByText("Latest activity")).toBeNull();
  });

  it("opens the workspace Soundboard from the newest sound card", async () => {
    const opened = vi.fn();
    renderHome(opened);
    await waitFor(() => expect(screen.getByTestId("home-latest-sound")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(opened).toHaveBeenCalledOnce();
  });

  it("opens member details from a Dashboard nickname", async () => {
    getMock.mockImplementation((path: string) =>
      path.endsWith("/home")
        ? Promise.resolve(response)
        : Promise.resolve({
            perUser: [{ userId: A_ID, messages: 42, streamSeconds: 7_200 }],
            watchPairs: [],
          }),
    );
    renderHome();
    await waitFor(() => expect(screen.getByTestId(`home-member-${A_ID}`)).toBeDefined());

    fireEvent.click(screen.getByTestId(`home-member-name-${A_ID}`));
    expect(await screen.findByTestId("user-profile-dialog")).toBeDefined();
    expect(screen.getByTestId("user-profile-name").textContent).toBe("Roman");
    await waitFor(() => expect(screen.getByTestId("user-profile-messages").textContent).toBe("42"));
  });

  it("subscribes to every domain event that can change the recap", async () => {
    renderHome();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(onMock.mock.calls.map((call) => call[0])).toEqual([
      "hangout.updated",
      "screenshot.updated",
      "sound.updated",
      "rec.state",
      "points.updated",
    ]);
  });
});
