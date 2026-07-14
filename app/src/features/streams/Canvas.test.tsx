import type { Member, StreamInfo } from "@tavern/shared";
import { computeLayout } from "@tavern/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Canvas } from "@/features/streams/Canvas";
import { useMediaStore } from "@/stores/media";
import { resetRoomStores, roomStore } from "@/stores/room";

// Wrap the real computeLayout so rows stay App-C-correct while we can assert its call args.
vi.mock("@tavern/shared", async (importActual) => {
  const actual = await importActual<typeof import("@tavern/shared")>();
  return { ...actual, computeLayout: vi.fn(actual.computeLayout) };
});

// Stub the tile — Canvas.test asserts layout (rows/order/focus) + which local stream Canvas routes to
// each tile (selfStreamFor), not tile internals (useWatch). The stub records the `selfStream` prop per
// trackName so the FR-29 routing test can assert it.
const selfStreams = vi.hoisted(() => new Map<string, MediaStream | null>());
const mountCounts = vi.hoisted(() => new Map<string, number>());
const theaterMock = vi.hoisted(() => vi.fn());
vi.mock("@/features/streams/useWatch", () => ({
  isWatchingTrack: () => false,
  setWatchTheaterFullscreen: theaterMock,
}));
vi.mock("@/features/streams/StreamTile", () => ({
  StreamTile: ({
    stream: tile,
    selfStream,
    compact,
  }: {
    stream: StreamInfo;
    selfStream?: MediaStream | null;
    compact?: boolean;
  }) => {
    selfStreams.set(tile.trackName, selfStream ?? null);
    useEffect(() => {
      mountCounts.set(tile.trackName, (mountCounts.get(tile.trackName) ?? 0) + 1);
    }, [tile.trackName]);
    return <div data-testid={`stream-tile-${tile.trackName}`} data-compact={compact ?? false} />;
  },
}));
vi.mock("@/features/streams/VoiceAvatarTile", () => ({
  VoiceAvatarTile: ({
    compact,
    member,
    onFocus,
  }: {
    compact?: boolean;
    member: { profile: Member };
    onFocus: () => void;
  }) => (
    <button
      type="button"
      data-testid={`voice-avatar-tile-${member.profile.userId}`}
      data-compact={compact ?? false}
      onClick={onFocus}
    >
      {member.profile.displayName}
    </button>
  ),
}));

// jsdom has no ResizeObserver; retain callback/target pairs so a test can resize the stream pane even
// when another component (such as Base UI Tabs) observes its own element.
const resizeObservers: Array<{ callback: ResizeObserverCallback; target: Element | null }> = [];
class FakeResizeObserver {
  private readonly entry: { callback: ResizeObserverCallback; target: Element | null };

  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, target: null };
    resizeObservers.push(this.entry);
  }
  observe(target: Element): void {
    this.entry.target = target;
  }
  disconnect(): void {}
  unobserve(): void {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

const SRV = "srv";

function stream(trackName: string, over: Partial<StreamInfo> = {}): StreamInfo {
  return { trackName, kind: "screen", userId: "u", hasAudio: false, preset: "1080p30", ...over };
}

function seed(streams: StreamInfo[], focusedTrackName: string | null = null): void {
  roomStore(SRV).setState({ streams, focusedTrackName });
}

function voiceMember(userId: string, displayName: string): Member {
  return {
    userId,
    username: userId,
    displayName,
    color: "#8b5cf6",
    presence: "in-voice",
    isAdmin: false,
    joinedAt: 1,
  };
}

function seedVoice(profiles: Member[]): void {
  roomStore(SRV).setState({
    members: profiles,
    voice: {
      members: profiles.map((profile) => ({
        userId: profile.userId,
        muted: false,
        deafened: false,
      })),
      sessionStartedAt: 1,
    },
  });
}

function tileCount(row: number): number {
  return screen
    .getByTestId("canvas")
    .querySelectorAll(`[data-layout-row="${row}"] [data-testid^="stream-tile-"]`).length;
}

beforeEach(() => {
  resizeObservers.length = 0;
  resetRoomStores();
  useMediaStore.setState({ shareTrackName: null, shareStream: null, sharing: false });
  selfStreams.clear();
  mountCounts.clear();
  vi.mocked(computeLayout).mockClear();
  theaterMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("FR-32 canvas auto-layout", () => {
  it("3 streams render rows [2,1] per App-C", () => {
    seed([stream("s3"), stream("s1"), stream("s2")]);
    render(<Canvas serverId={SRV} active />);
    expect(tileCount(0)).toBe(2);
    expect(tileCount(1)).toBe(1);
    expect(tileCount(2)).toBe(0);
  });

  it("6 streams render [3,3]", () => {
    seed([1, 2, 3, 4, 5, 6].map((n) => stream(`s${n}`)));
    render(<Canvas serverId={SRV} active />);
    expect(tileCount(0)).toBe(3);
    expect(tileCount(1)).toBe(3);
  });

  it("tile order is trackName ascending", () => {
    seed([stream("screen:c:1"), stream("screen:a:1"), stream("screen:b:1")]);
    render(<Canvas serverId={SRV} active />);
    const order = screen
      .getAllByTestId(/^stream-tile-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "stream-tile-screen:a:1",
      "stream-tile-screen:b:1",
      "stream-tile-screen:c:1",
    ]);
  });

  it("resize recomputes rows via computeLayout args", () => {
    seed([stream("s1"), stream("s2"), stream("s3")]);
    render(<Canvas serverId={SRV} active />);
    const streamPane = screen.getByTestId("canvas");
    const observer = resizeObservers.find((candidate) => candidate.target === streamPane);
    if (observer === undefined) throw new Error("stream pane resize observer was not registered");
    act(() => {
      observer.callback(
        [{ contentRect: { width: 1600, height: 400 } } as unknown as ResizeObserverEntry],
        {} as unknown as ResizeObserver,
      );
    });
    expect(computeLayout).toHaveBeenCalledWith(3, 1600, 400);
  });
});

describe("FR-33 focus mode layout", () => {
  it("focused stream fills the top; others render as thumbnails in the bottom filmstrip", () => {
    seed([stream("s1"), stream("s2"), stream("s3")], "s2");
    render(<Canvas serverId={SRV} active />);
    const canvas = screen.getByTestId("canvas");
    expect(canvas.getAttribute("data-focused")).toBe("true");
    expect(screen.getByTestId("focus-strip")).not.toBeNull();
    expect(screen.getByTestId("stream-slot-s2").getAttribute("data-focused-tile")).toBe("true");
    expect(screen.getByTestId("stream-slot-s1").getAttribute("data-focus-thumbnail")).toBe("true");
    expect(screen.getByTestId("stream-slot-s3").getAttribute("data-focus-thumbnail")).toBe("true");
    expect(screen.getByTestId("stream-tile-s2").getAttribute("data-compact")).toBe("false");
    expect(screen.getByTestId("stream-tile-s1").getAttribute("data-compact")).toBe("true");
    expect(screen.getByTestId("stream-tile-s3").getAttribute("data-compact")).toBe("true");
  });

  it("keeps each tile mounted while moving between grid, focus, and fullscreen", () => {
    seed([stream("s1"), stream("s2")]);
    render(<Canvas serverId={SRV} active />);
    const original = screen.getByTestId("stream-tile-s1");

    act(() => roomStore(SRV).getState().setFocusedTrackName("s1"));
    expect(screen.getByTestId("stream-tile-s1")).toBe(original);
    act(() => roomStore(SRV).getState().setFullscreenTrackName("s1"));
    expect(screen.getByTestId("stream-tile-s1")).toBe(original);
    expect(screen.getByTestId("stream-slot-s2").style.display).toBe("none");
    act(() => roomStore(SRV).getState().setFullscreenTrackName(null));
    expect(screen.getByTestId("stream-tile-s1")).toBe(original);
    expect(mountCounts.get("s1")).toBe(1);
    expect(mountCounts.get("s2")).toBe(1);
  });

  it("marks only the fullscreen track as theater-visible and clears policy on exit", () => {
    seed([stream("s1"), stream("s2")]);
    render(<Canvas serverId={SRV} active />);

    act(() => roomStore(SRV).setState({ fullscreenTrackName: "s2" }));
    expect(theaterMock).toHaveBeenLastCalledWith(SRV, "s2");

    act(() => roomStore(SRV).setState({ fullscreenTrackName: null }));
    expect(theaterMock).toHaveBeenLastCalledWith(SRV, null);
  });

  it("places voice avatars beside streams and promotes a clicked avatar to the main stage", () => {
    const ada = voiceMember("ada", "Ada");
    const grace = voiceMember("grace", "Grace");
    seed([stream("s1")], "s1");
    seedVoice([grace, ada]);
    render(<Canvas serverId={SRV} active />);

    expect(screen.getByTestId("stream-slot-s1").getAttribute("data-focused-tile")).toBe("true");
    expect(screen.getByTestId("voice-avatar-slot-ada").getAttribute("data-focus-thumbnail")).toBe(
      "true",
    );
    expect(screen.getByTestId("voice-avatar-tile-ada").getAttribute("data-compact")).toBe("true");

    fireEvent.click(screen.getByTestId("voice-avatar-tile-ada"));
    expect(roomStore(SRV).getState().focusedTrackName).toBeNull();
    expect(roomStore(SRV).getState().focusedVoiceUserId).toBe("ada");
    expect(screen.getByTestId("voice-avatar-slot-ada").getAttribute("data-focused-tile")).toBe(
      "true",
    );
    expect(screen.getByTestId("stream-slot-s1").getAttribute("data-focus-thumbnail")).toBe("true");

    fireEvent.keyDown(window, { key: "f" });
    expect(roomStore(SRV).getState().fullscreenVoiceUserId).toBe("ada");
    expect(screen.getByTestId("canvas").getAttribute("data-fullscreen")).toBe("true");
    expect(screen.getByTestId("voice-avatar-slot-ada").getAttribute("data-fullscreen-tile")).toBe(
      "true",
    );
  });
});

describe("voice participant layout", () => {
  it("renders voice-only rooms in the same auto-layout grid", () => {
    seedVoice([voiceMember("a", "Ada"), voiceMember("b", "Bryn"), voiceMember("c", "Cleo")]);
    render(<Canvas serverId={SRV} active />);

    expect(screen.getAllByTestId(/^voice-avatar-tile-/)).toHaveLength(3);
    expect(computeLayout).toHaveBeenCalledWith(3, 0, 0);
    expect(screen.getByTestId("voice-avatar-slot-a").getAttribute("data-layout-row")).toBe("0");
    expect(screen.getByTestId("voice-avatar-slot-c").getAttribute("data-layout-row")).toBe("1");
  });

  it("replaces only the avatar with a webcam while keeping the user's screen share", () => {
    const ada = voiceMember("ada", "Ada");
    const webcam = stream("cam:ada", { kind: "webcam", userId: ada.userId });
    const screenShare = stream("screen:ada:1", { kind: "screen", userId: ada.userId });
    seed([screenShare, webcam]);
    seedVoice([ada]);
    render(<Canvas serverId={SRV} active />);

    expect(screen.queryByTestId("voice-avatar-tile-ada")).toBeNull();
    expect(screen.getByTestId("stream-tile-cam:ada")).toBeDefined();
    expect(screen.getByTestId("stream-tile-screen:ada:1")).toBeDefined();

    act(() => roomStore(SRV).setState({ streams: [screenShare] }));
    expect(screen.getByTestId("voice-avatar-tile-ada")).toBeDefined();
    expect(screen.getByTestId("stream-tile-screen:ada:1")).toBeDefined();
  });

  it("transfers avatar focus/fullscreen to a starting webcam and back when it stops", () => {
    const ada = voiceMember("ada", "Ada");
    const webcam = stream("cam:ada", { kind: "webcam", userId: ada.userId });
    seedVoice([ada]);
    roomStore(SRV).getState().setFullscreenVoiceUserId(ada.userId);

    act(() => roomStore(SRV).getState().apply({ t: "stream.added", stream: webcam, at: 2 }));
    expect(roomStore(SRV).getState().focusedVoiceUserId).toBeNull();
    expect(roomStore(SRV).getState().fullscreenVoiceUserId).toBeNull();
    expect(roomStore(SRV).getState().focusedTrackName).toBe(webcam.trackName);
    expect(roomStore(SRV).getState().fullscreenTrackName).toBe(webcam.trackName);

    act(() =>
      roomStore(SRV).getState().apply({ t: "stream.removed", trackName: webcam.trackName, at: 3 }),
    );
    expect(roomStore(SRV).getState().focusedVoiceUserId).toBe(ada.userId);
    expect(roomStore(SRV).getState().fullscreenVoiceUserId).toBe(ada.userId);
    expect(roomStore(SRV).getState().focusedTrackName).toBeNull();
    expect(roomStore(SRV).getState().fullscreenTrackName).toBeNull();
  });
});

describe("FR-29 self-preview routing", () => {
  it("routes the local screen-share stream to the tile matching shareTrackName", () => {
    // A fake stand-in for the local screen MediaStream (jsdom has no MediaStream constructor).
    const preview = { id: "screen-preview" } as unknown as MediaStream;
    useMediaStore.setState({
      sharing: true,
      shareTrackName: "screen:me:1",
      shareStream: preview,
    });
    seed([stream("screen:me:1"), stream("screen:other:1")]);
    render(<Canvas serverId={SRV} active />);
    // The sharer's own tile gets the live local stream (→ live preview, not black); every other tile
    // gets null (it pulls from the SFU instead).
    expect(selfStreams.get("screen:me:1")).toBe(preview);
    expect(selfStreams.get("screen:other:1")).toBeNull();
  });
});
