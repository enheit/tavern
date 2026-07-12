import type { StreamInfo } from "@tavern/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamTile } from "@/features/streams/StreamTile";
import { focusStore } from "@/lib/focusState";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { fakeStream, fakeTrack } from "../../../test/fakes/media";

// useWatch is mocked — StreamTile.test drives the tile's UI (volume, focus) against a controlled
// watch state, not the real PullSession engine.
const watchMock = vi.hoisted(() => ({
  state: "watching" as "idle" | "connecting" | "watching",
  mediaStream: null as MediaStream | null,
  watch: vi.fn(),
  unwatch: vi.fn(),
  setLayer: vi.fn(),
}));
vi.mock("@/features/streams/useWatch", () => ({ useWatch: () => watchMock }));

// The shared graph sink is reached via getVoiceController(); spy its setStreamGain (FR-31).
const sinkMock = vi.hoisted(() => ({
  attachStreamAudio: vi.fn(),
  detachStreamAudio: vi.fn(),
  setStreamGain: vi.fn(),
}));
vi.mock("@/features/voice/voiceController", () => ({
  getVoiceController: () => ({ streamAudioSink: () => sinkMock }),
}));

// useScreenShare is mocked — the own-tile dropdown reads the live self-share preset + drives setPreset,
// both exercised for real in useScreenShare.test.ts; here we only assert the dropdown's visibility rules.
const shareMock = vi.hoisted(() => ({
  sharing: true,
  preset: "1080p30" as string | null,
  trackName: null as string | null,
  start: vi.fn(),
  stop: vi.fn(),
  setPreset: vi.fn(),
}));
vi.mock("@/features/streams/useScreenShare", () => ({ useScreenShare: () => shareMock }));

const UID = "22222222-2222-4222-8222-222222222222";

function makeStream(over: Partial<StreamInfo> = {}): StreamInfo {
  return {
    trackName: `screen:${UID}:1`,
    kind: "screen",
    userId: UID,
    hasAudio: false,
    preset: "1080p30",
    ...over,
  };
}

// FR-31 volume is now a scroll gesture on the tile (no slider). Middle-click = reset to 0.
function middleClick(el: Element): void {
  el.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  watchMock.state = "watching";
  watchMock.mediaStream = null;
  vi.clearAllMocks();
  // Default: no self identity, so UID-owned streams are NOT self tiles and the own-tile dropdown is
  // hidden. The FR-27 tests opt in per case; the FR-29 self describe sets a matching profile explicitly.
  useSessionStore.setState({ status: "unauthed", profile: null });
  useSettingsStore.setState({
    volumes: { v: 1, users: {}, streams: {}, soundboard: 1, mutedUsers: [] },
  });
});

afterEach(() => {
  cleanup();
});

describe("FR-30 opt-in placeholder", () => {
  it("idle tile shows a Watch button + kind icon and opts in on click", () => {
    watchMock.state = "idle";
    const stream = makeStream();
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);

    expect(screen.getByTestId(`stream-kind-${stream.trackName}`)).not.toBeNull();
    // No video / volume in the placeholder.
    expect(screen.queryByTestId(`stream-video-${stream.trackName}`)).toBeNull();

    fireEvent.click(screen.getByTestId(`stream-watch-${stream.trackName}`));
    expect(watchMock.watch).toHaveBeenCalledTimes(1);
  });
});

describe("FR-31 per-stream volume", () => {
  it("scroll adjusts setStreamGain in 5% steps keyed by userId:kind and persists", () => {
    const key = `${UID}:screen`;
    const stream = makeStream({ hasAudio: true });
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);
    const tile = screen.getByTestId(`stream-tile-${stream.trackName}`);

    fireEvent.wheel(tile, { deltaY: -100 }); // up = louder
    expect(sinkMock.setStreamGain).toHaveBeenLastCalledWith(key, 1.05);
    expect(useSettingsStore.getState().volumes.streams[key]).toBe(1.05);

    fireEvent.wheel(tile, { deltaY: 100 }); // down = quieter, reads the persisted 1.05
    expect(sinkMock.setStreamGain).toHaveBeenLastCalledWith(key, 1);
  });

  it("middle-click resets the stream to 0%", () => {
    const key = `${UID}:screen`;
    const stream = makeStream({ hasAudio: true });
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);

    middleClick(screen.getByTestId(`stream-tile-${stream.trackName}`));
    expect(sinkMock.setStreamGain).toHaveBeenLastCalledWith(key, 0);
    expect(useSettingsStore.getState().volumes.streams[key]).toBe(0);
  });

  it("no volume gesture when hasAudio=false", () => {
    const stream = makeStream({ hasAudio: false });
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);
    fireEvent.wheel(screen.getByTestId(`stream-tile-${stream.trackName}`), { deltaY: -100 });
    expect(sinkMock.setStreamGain).not.toHaveBeenCalled();
  });
});

// A wrapper mirroring Canvas: clicking the tile fires the focus toggle. Focus is a pure LAYOUT
// concern now — the pull is pinned to the high simulcast layer from the start, no layer switching.
function FocusHarness({ stream, onToggle }: { stream: StreamInfo; onToggle: () => void }) {
  return <StreamTile stream={stream} onToggleFocus={onToggle} onToggleFullscreen={vi.fn()} />;
}

describe("FR-27 preset dropdown removed from tiles (tuning lives in the ControlsBar)", () => {
  const self = { userId: UID, username: "me", displayName: "Me", color: "#abcdef" };

  it("dropdown is absent even on the sharer's OWN screen tile", () => {
    useSessionStore.setState({ profile: self });
    const stream = makeStream({ userId: UID, kind: "screen" });
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);
    expect(screen.queryByTestId(`stream-preset-${stream.trackName}`)).toBeNull();
  });

  it("dropdown is absent on the OWN webcam tile (webcam preset is fixed)", () => {
    useSessionStore.setState({ profile: self });
    const stream = makeStream({
      userId: UID,
      kind: "webcam",
      trackName: `cam:${UID}`,
      preset: "720p30",
    });
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);
    expect(screen.queryByTestId(`stream-preset-${stream.trackName}`)).toBeNull();
  });

  it("dropdown is absent on ANOTHER member's screen tile", () => {
    useSessionStore.setState({ profile: self });
    const other = "33333333-3333-4333-8333-333333333333";
    const stream = makeStream({ userId: other, kind: "screen", trackName: `screen:${other}:1` });
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);
    expect(screen.queryByTestId(`stream-preset-${stream.trackName}`)).toBeNull();
  });
});

describe("FR-33 focus toggle", () => {
  it("click watched tile toggles focus (layout only) — never a simulcast layer switch", () => {
    const stream = makeStream();
    const onToggle = vi.fn();
    render(<FocusHarness stream={stream} onToggle={onToggle} />);
    const tile = screen.getByTestId(`stream-tile-${stream.trackName}`);

    fireEvent.click(tile); // enter focus
    fireEvent.click(tile); // leave focus

    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(watchMock.setLayer).not.toHaveBeenCalled();
    expect(tile.getAttribute("data-watching")).toBe("true");
  });
});

describe("FR-29 self preview", () => {
  function seedSelf(): void {
    useSessionStore.setState({
      status: "authed",
      profile: { userId: UID, username: "me", displayName: "Me", color: "#abcdef" },
    });
  }

  it("own cam tile renders local stream muted with You badge", () => {
    seedSelf();
    // jsdom provides no MediaStream constructor; the fake double is what the tile assigns to
    // `<video>.srcObject` (jsdom stores it as-is), which is all the self-preview needs.
    const selfStream = fakeStream({ video: [fakeTrack("video")] });
    const stream = makeStream({ kind: "webcam", trackName: `cam:${UID}` });
    render(
      <StreamTile
        stream={stream}
        selfStream={selfStream}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const video = screen.getByTestId(`stream-self-${stream.trackName}`) as HTMLVideoElement;
    expect(video.srcObject).toBe(selfStream);
    expect(video.muted).toBe(true);
    // The "You" badge marks the sharer's own tile (m.streams_self → "You").
    expect(screen.getByTestId(`stream-self-badge-${stream.trackName}`).textContent).toBe("You");
  });

  it("covers the preview with a 'still running' card while the window is unfocused", () => {
    seedSelf();
    focusStore.setState({ focused: false });
    const selfStream = fakeStream({ video: [fakeTrack("video")] });
    const stream = makeStream({ kind: "webcam", trackName: `cam:${UID}` });
    render(
      <StreamTile
        stream={stream}
        selfStream={selfStream}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    // Cover is shown, but the <video> stays mounted (srcObject intact) so preview snaps back on focus.
    const cover = screen.getByTestId(`stream-self-paused-${stream.trackName}`);
    expect(cover.textContent).toContain("Your stream is still running");
    expect(cover.textContent).toContain("We paused the preview to save resources.");
    const video = screen.getByTestId(`stream-self-${stream.trackName}`) as HTMLVideoElement;
    expect(video.srcObject).toBe(selfStream);
  });

  it("hides the cover and shows the live preview while the window is focused", () => {
    seedSelf();
    focusStore.setState({ focused: true });
    const stream = makeStream({ kind: "webcam", trackName: `cam:${UID}` });
    render(
      <StreamTile
        stream={stream}
        selfStream={fakeStream({ video: [fakeTrack("video")] })}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(screen.queryByTestId(`stream-self-paused-${stream.trackName}`)).toBeNull();
    expect(screen.getByTestId(`stream-self-${stream.trackName}`)).not.toBeNull();
  });

  it("own tiles never render a Watch button", () => {
    seedSelf();
    // Even with the watch engine idle, a self tile shows no Watch — you never pull your own stream.
    watchMock.state = "idle";
    const stream = makeStream({ kind: "webcam", trackName: `cam:${UID}` });
    render(
      <StreamTile
        stream={stream}
        selfStream={null}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(screen.queryByTestId(`stream-watch-${stream.trackName}`)).toBeNull();
    expect(screen.queryByTestId(`stream-unwatch-${stream.trackName}`)).toBeNull();
  });

  it("remote cam tile renders placeholder + Watch (FR-30 applies to webcams)", () => {
    // A DIFFERENT user's webcam — the local profile is someone else, so it is a normal opt-in tile.
    useSessionStore.setState({
      status: "authed",
      profile: { userId: "someone-else", username: "x", displayName: "X", color: "#111111" },
    });
    watchMock.state = "idle";
    const stream = makeStream({ kind: "webcam", trackName: `cam:${UID}` });
    render(
      <StreamTile
        stream={stream}
        selfStream={null}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(screen.getByTestId(`stream-watch-${stream.trackName}`)).not.toBeNull();
    expect(screen.getByTestId(`stream-kind-${stream.trackName}`)).not.toBeNull();
    expect(screen.queryByTestId(`stream-self-${stream.trackName}`)).toBeNull();
  });
});
