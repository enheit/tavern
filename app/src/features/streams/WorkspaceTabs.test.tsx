import type { StreamInfo } from "@tavern/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRoomStores, roomStore } from "@/stores/room";
import { m } from "@/paraglide/messages.js";
import { WorkspaceTabs } from "./WorkspaceTabs";

vi.mock("@/features/home/TavernHome", () => ({
  TavernHome: ({ onOpenSoundboard, active }: { onOpenSoundboard: () => void; active: boolean }) => (
    <div data-testid="tavern-home" data-active={String(active)}>
      <button type="button" onClick={onOpenSoundboard}>
        {m.home_open_soundboard()}
      </button>
    </div>
  ),
}));
vi.mock("@/features/recordings/RecordingsTab", () => ({
  RecordingsTab: () => <div data-testid="recordings-panel" />,
}));
vi.mock("@/features/screenshots/ScreenshotsTab", () => ({
  ScreenshotsTab: () => <div data-testid="screenshots-panel" />,
}));
vi.mock("@/features/soundboard/SoundboardPanel", () => ({
  SoundboardPanel: () => <div data-testid="soundboard-panel" />,
}));
vi.mock("@/features/polls/PollsTab", () => ({
  PollsTab: () => <div data-testid="polls-panel" />,
}));
vi.mock("@/features/market/MarketTab", () => ({
  MarketTab: () => <div data-testid="market-panel" />,
}));
vi.mock("./Canvas", () => ({
  Canvas: ({ active }: { active: boolean }) => (
    <div data-testid="canvas" data-active={String(active)} />
  ),
}));

const SERVER_ID = "workspace-server";

function stream(trackName: string): StreamInfo {
  return {
    trackName,
    kind: "screen",
    userId: "user-1",
    hasAudio: false,
    preset: "1080p30",
  };
}

beforeEach(() => resetRoomStores());
afterEach(() => cleanup());

describe("workspace navigation", () => {
  it("shows the requested non-stream tabs in order and defaults to Dashboard", () => {
    render(<WorkspaceTabs serverId={SERVER_ID} />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Dashboard",
      "Recordings",
      "Screenshots",
      "Soundboard",
      "Polls",
      "Market",
    ]);
    expect(screen.getByTestId("workspace-tab-dashboard").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByTestId("workspace-tab-stream")).toBeNull();
  });

  it("keeps Dashboard and Stream mounted while switching center views", () => {
    roomStore(SERVER_ID).setState({ streams: [stream("screen:user-1:1")] });
    render(<WorkspaceTabs serverId={SERVER_ID} />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Dashboard",
      "Stream",
      "Recordings",
      "Screenshots",
      "Soundboard",
      "Polls",
      "Market",
    ]);
    expect(screen.getByTestId("workspace-tab-stream").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("canvas").dataset.active).toBe("true");
    expect(screen.getByTestId("tavern-home").dataset.active).toBe("false");
    expect(screen.getByTestId("tavern-home")).toBeDefined();

    fireEvent.click(screen.getByTestId("workspace-tab-recordings"));
    expect(screen.getByTestId("recordings-panel")).toBeDefined();
    expect(screen.getByTestId("canvas").dataset.active).toBe("false");
    expect(screen.getByTestId("tavern-home").dataset.active).toBe("false");
    expect(screen.getByTestId("tavern-home")).toBeDefined();
  });

  it("shows the Stream workspace for voice participants even when nobody is sharing video", () => {
    roomStore(SERVER_ID).setState({
      voice: {
        members: [{ userId: "voice-user", muted: false, deafened: false }],
        sessionStartedAt: 1,
      },
    });
    render(<WorkspaceTabs serverId={SERVER_ID} />);

    expect(screen.getByTestId("workspace-tab-stream").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("canvas").dataset.active).toBe("true");
  });

  it("treats a webcam as the same visual participant while a screen share remains additional", () => {
    roomStore(SERVER_ID).setState({
      voice: {
        members: [{ userId: "voice-user", muted: false, deafened: false }],
        sessionStartedAt: 1,
      },
    });
    render(<WorkspaceTabs serverId={SERVER_ID} />);
    fireEvent.click(screen.getByTestId("workspace-tab-recordings"));

    act(() =>
      roomStore(SERVER_ID).setState({
        streams: [{ ...stream("cam:voice-user"), kind: "webcam", userId: "voice-user" }],
      }),
    );
    expect(screen.getByTestId("workspace-tab-recordings").getAttribute("aria-selected")).toBe(
      "true",
    );

    act(() =>
      roomStore(SERVER_ID).setState({
        streams: [
          { ...stream("cam:voice-user"), kind: "webcam", userId: "voice-user" },
          { ...stream("screen:voice-user:1"), userId: "voice-user" },
        ],
      }),
    );
    expect(screen.getByTestId("workspace-tab-stream").getAttribute("aria-selected")).toBe("true");
  });

  it("opens new streams automatically and only falls back from the Stream view", () => {
    render(<WorkspaceTabs serverId={SERVER_ID} />);

    act(() => roomStore(SERVER_ID).setState({ streams: [stream("screen:user-1:1")] }));
    expect(screen.getByTestId("workspace-tab-stream").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByTestId("workspace-tab-screenshots"));
    act(() => roomStore(SERVER_ID).setState({ streams: [] }));
    expect(screen.getByTestId("workspace-tab-screenshots").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByTestId("workspace-tab-stream")).toBeNull();

    act(() => roomStore(SERVER_ID).setState({ streams: [stream("screen:user-1:2")] }));
    expect(screen.getByTestId("workspace-tab-stream").getAttribute("aria-selected")).toBe("true");
    act(() => roomStore(SERVER_ID).setState({ streams: [] }));
    expect(screen.getByTestId("workspace-tab-dashboard").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("opens Soundboard from the Dashboard card", () => {
    render(<WorkspaceTabs serverId={SERVER_ID} />);
    fireEvent.click(screen.getByRole("button", { name: m.home_open_soundboard() }));

    expect(screen.getByTestId("workspace-tab-soundboard").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByTestId("soundboard-panel")).toBeDefined();
  });
});
