import type { Member, StreamInfo } from "@tavern/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamTile } from "@/features/streams/StreamTile";
import { focusStore } from "@/lib/focusState";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { fakeStream, fakeTrack } from "../../../test/fakes/media";
import { resetQualityMonitoringForTests, useQualityStore } from "@/media/qualityMonitor";

// useWatch is mocked — StreamTile.test drives the tile's UI (volume, focus) against a controlled
// watch state, not the real PullSession engine.
const watchMock = vi.hoisted(() => ({
  state: "watching" as "idle" | "connecting" | "watching",
  mediaStream: null as MediaStream | null,
  watch: vi.fn(),
  unwatch: vi.fn(),
}));
vi.mock("@/features/streams/useWatch", () => ({ useWatch: () => watchMock }));

const previewMock = vi.hoisted(() => ({ url: null as string | null }));
vi.mock("@/features/streams/useStreamPreview", () => ({
  useStreamPreview: () => previewMock.url,
}));

// The shared graph sink is reached via getVoiceController(); spy its setStreamVolume (FR-31).
const sinkMock = vi.hoisted(() => ({
  attachStreamAudio: vi.fn(),
  detachStreamAudio: vi.fn(),
  setStreamVolume: vi.fn(),
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
const SERVER_ID = "stream-placeholder-test";

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

function seedStreamStats(trackName: string): void {
  useQualityStore.getState().setSnapshot(trackName, {
    role: "viewer",
    health: "network_limited",
    limitation: "bandwidth",
    contentMode: "motion",
    width: 1920,
    height: 1080,
    fps: 46.4,
    targetFps: 60,
    bitrateKbps: 4200,
    rid: null,
    codec: "VP8",
  });
}

// FR-31 keeps the tile scroll gesture alongside the restored slider. Middle-click = reset to 0.
function middleClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
  });
}

// Base UI Slider exposes a native range input inside its thumb; driving that input avoids relying on
// pointer geometry that jsdom does not implement.
function setSlider(streamKey: string, percent: number): void {
  const input = screen
    .getByTestId(`stream-volume-${streamKey}`)
    .querySelector('input[type="range"]');
  if (input === null) throw new Error("stream volume slider has no range input");
  fireEvent.change(input, { target: { value: String(percent) } });
}

beforeEach(() => {
  watchMock.state = "watching";
  watchMock.mediaStream = null;
  previewMock.url = null;
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  focusStore.setState({ focused: true, visible: true });
  // Default: no self identity, so UID-owned streams are NOT self tiles and the own-tile dropdown is
  // hidden. The FR-27 tests opt in per case; the FR-29 self describe sets a matching profile explicitly.
  useSessionStore.setState({ status: "unauthed", profile: null });
  useSettingsStore.setState({
    volumes: { v: 1, users: {}, streams: {}, soundboard: 1, mutedUsers: [] },
  });
  resetRoomStores();
  useServersStore.setState({ activeServerId: null });
  resetQualityMonitoringForTests();
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

  it("tints the welcome thumbnail and its avatar placeholder with the broadcaster's color", () => {
    watchMock.state = "idle";
    const color = "#a855f7";
    const member: Member = {
      userId: UID,
      username: "streamer",
      displayName: "Streamer",
      color,
      presence: "online",
      isAdmin: false,
      joinedAt: 1,
    };
    useServersStore.setState({ activeServerId: SERVER_ID });
    roomStore(SERVER_ID).setState({ members: [member] });
    const stream = makeStream();

    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);

    const backgroundColor = screen.getByTestId(`stream-placeholder-${stream.trackName}`).style
      .backgroundColor;
    expect(backgroundColor).toContain("color-mix(in srgb,");
    expect(backgroundColor).toContain("rgb(168, 85, 247) 28%");
    const avatar = screen.getByTestId(`stream-avatar-${stream.trackName}`);
    expect(avatar.style.backgroundColor).toBe("rgb(168, 85, 247)");
    expect(avatar.textContent).toBe("S");
  });

  it("renders a dark, blurred teaser with a Preview label without mounting live video", () => {
    watchMock.state = "idle";
    previewMock.url = "blob:stream-preview";
    const stream = makeStream({
      preview: { id: "123e4567-e89b-42d3-a456-426614174000", version: "v1" },
    });

    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);

    const image = screen.getByTestId(`stream-preview-image-${stream.trackName}`);
    expect(image.getAttribute("src")).toBe("blob:stream-preview");
    expect(image.className).toContain("blur-sm");
    expect(screen.getByTestId(`stream-preview-shade-${stream.trackName}`).className).toContain(
      "bg-black/55",
    );
    expect(screen.getByText("Preview")).not.toBeNull();
    expect(screen.queryByTestId(`stream-video-${stream.trackName}`)).toBeNull();
  });
});

describe("Fullscreen controls", () => {
  it("places the fullscreen button after other overlay controls at the right edge", () => {
    const stream = makeStream();
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);

    const fullscreen = screen.getByTestId(`stream-fullscreen-${stream.trackName}`);
    const unwatch = screen.getByTestId(`stream-unwatch-${stream.trackName}`);
    expect(fullscreen.className).toContain("ml-auto");
    expect(
      unwatch.compareDocumentPosition(fullscreen) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("exits fullscreen before stopping the watch", () => {
    const stream = makeStream();
    const onToggleFullscreen = vi.fn();
    render(
      <StreamTile
        stream={stream}
        fullscreen
        onToggleFocus={vi.fn()}
        onToggleFullscreen={onToggleFullscreen}
      />,
    );

    fireEvent.click(screen.getByTestId(`stream-unwatch-${stream.trackName}`));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
    expect(watchMock.unwatch).toHaveBeenCalledTimes(1);
  });
});

describe("compact focus-strip controls", () => {
  it("keeps the Watch action readable and omits squeezed fullscreen/quality controls", () => {
    watchMock.state = "idle";
    const stream = makeStream();
    render(
      <StreamTile stream={stream} compact onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />,
    );

    expect(screen.getByTestId(`stream-watch-${stream.trackName}`).textContent).toBe("Watch");
    expect(screen.queryByTestId(`stream-fullscreen-${stream.trackName}`)).toBeNull();
    expect(screen.queryByTestId(`stream-stats-${stream.trackName}`)).toBeNull();
  });

  it("shows a direct Stop watching action for a compact live tile", () => {
    const stream = makeStream();
    render(
      <StreamTile stream={stream} compact onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId(`stream-unwatch-${stream.trackName}`));
    expect(watchMock.unwatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(`stream-fullscreen-${stream.trackName}`)).toBeNull();
  });
});

describe("focused/fullscreen stream statistics", () => {
  it("does not cover a normal grid tile or compact thumbnail", () => {
    const stream = makeStream();
    seedStreamStats(stream.trackName);

    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);
    expect(screen.queryByTestId(`stream-stats-${stream.trackName}`)).toBeNull();
  });

  it("shows actual codec, resolution and FPS in the top-right focused overlay and expands bitrate", () => {
    const stream = makeStream();
    seedStreamStats(stream.trackName);

    render(
      <StreamTile stream={stream} showStats onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />,
    );

    const overlay = screen.getByTestId(`stream-stats-${stream.trackName}`);
    expect(overlay.className).toContain("top-2");
    expect(overlay.className).toContain("right-2");
    expect(overlay.textContent).toContain("VP8");
    expect(overlay.textContent).toContain("1920×1080");
    expect(overlay.textContent).toContain("46 fps");
    expect(overlay.textContent).not.toContain("4.2 Mbps");
    expect(overlay.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(overlay);
    expect(overlay.getAttribute("aria-expanded")).toBe("true");
    expect(overlay.textContent).toContain("4.2 Mbps");
  });
});

describe("FR-31 per-stream volume", () => {
  it("scroll adjusts setStreamVolume in 5% steps keyed by userId:kind and persists", () => {
    const key = `${UID}:screen`;
    const stream = makeStream({ hasAudio: true });
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);
    const tile = screen.getByTestId(`stream-tile-${stream.trackName}`);

    fireEvent.wheel(tile, { deltaY: -100 }); // up = louder
    expect(sinkMock.setStreamVolume).toHaveBeenLastCalledWith(key, 1.05);
    expect(useSettingsStore.getState().volumes.streams[key]).toBe(1.05);
    expect(screen.getByTestId(`stream-volume-percent-${key}`).textContent).toBe("105%");

    fireEvent.wheel(tile, { deltaY: 100 }); // down = quieter, reads the persisted 1.05
    expect(sinkMock.setStreamVolume).toHaveBeenLastCalledWith(key, 1);
    expect(screen.getByTestId(`stream-volume-percent-${key}`).textContent).toBe("100%");
  });

  it("restores the 0–200% slider and keeps its value synchronized with persistence", () => {
    const key = `${UID}:screen`;
    const stream = makeStream({ hasAudio: true });
    const onToggleFocus = vi.fn();
    render(
      <StreamTile stream={stream} onToggleFocus={onToggleFocus} onToggleFullscreen={vi.fn()} />,
    );

    expect(screen.getByTestId(`stream-volume-percent-${key}`).textContent).toBe("100%");
    setSlider(key, 15);
    expect(sinkMock.setStreamVolume).toHaveBeenLastCalledWith(key, 0.15);
    expect(useSettingsStore.getState().volumes.streams[key]).toBe(0.15);
    expect(screen.getByTestId(`stream-volume-percent-${key}`).textContent).toBe("15%");

    setSlider(key, 200);
    expect(sinkMock.setStreamVolume).toHaveBeenLastCalledWith(key, 2);
    expect(useSettingsStore.getState().volumes.streams[key]).toBe(2);
    expect(screen.getByTestId(`stream-volume-percent-${key}`).textContent).toBe("200%");

    fireEvent.click(screen.getByTestId(`stream-volume-${key}`));
    expect(onToggleFocus).not.toHaveBeenCalled();
  });

  it("middle-click resets the stream to 0%", () => {
    const key = `${UID}:screen`;
    const stream = makeStream({ hasAudio: true });
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);

    middleClick(screen.getByTestId(`stream-tile-${stream.trackName}`));
    expect(sinkMock.setStreamVolume).toHaveBeenLastCalledWith(key, 0);
    expect(useSettingsStore.getState().volumes.streams[key]).toBe(0);
    expect(screen.getByTestId(`stream-volume-percent-${key}`).textContent).toBe("0%");
  });

  it("has no volume gesture or slider when hasAudio=false", () => {
    const stream = makeStream({ hasAudio: false });
    render(<StreamTile stream={stream} onToggleFocus={vi.fn()} onToggleFullscreen={vi.fn()} />);
    fireEvent.wheel(screen.getByTestId(`stream-tile-${stream.trackName}`), { deltaY: -100 });
    expect(sinkMock.setStreamVolume).not.toHaveBeenCalled();
    expect(screen.queryByTestId(`stream-volume-${UID}:screen`)).toBeNull();
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
  it("click watched tile toggles focus as a layout-only action", () => {
    const stream = makeStream();
    const onToggle = vi.fn();
    render(<FocusHarness stream={stream} onToggle={onToggle} />);
    const tile = screen.getByTestId(`stream-tile-${stream.trackName}`);

    fireEvent.click(tile); // enter focus
    fireEvent.click(tile); // leave focus

    expect(onToggle).toHaveBeenCalledTimes(2);
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
    const videoTrack = fakeTrack("video");
    const selfStream = fakeStream({ video: [videoTrack] });
    const stream = makeStream({ kind: "webcam", trackName: `cam:${UID}` });
    render(
      <StreamTile
        stream={stream}
        selfStream={selfStream}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    // Cover is shown and the local preview is detached; the publisher track itself is untouched.
    const cover = screen.getByTestId(`stream-self-paused-${stream.trackName}`);
    expect(cover.textContent).toContain("Your stream is still running");
    expect(cover.textContent).toContain("We paused the preview to save resources.");
    const video = screen.getByTestId(`stream-self-${stream.trackName}`) as HTMLVideoElement;
    expect(video.srcObject).toBeNull();
    expect(videoTrack.stop).not.toHaveBeenCalled();
  });

  it("keeps the same visible video and shows no preview controls during a size change", () => {
    seedSelf();
    focusStore.setState({ focused: true });
    const stream = makeStream({ kind: "webcam", trackName: `cam:${UID}` });
    const selfStream = fakeStream({ video: [fakeTrack("video")] });
    const { rerender } = render(
      <StreamTile
        stream={stream}
        selfStream={selfStream}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const video = screen.getByTestId(`stream-self-${stream.trackName}`);
    expect(
      screen.getByTestId(`stream-tile-${stream.trackName}`).getAttribute("data-preview-state"),
    ).toBe("resuming");
    expect(screen.queryByTestId(`stream-self-paused-${stream.trackName}`)).toBeNull();
    fireEvent.playing(video);
    expect(screen.queryByTestId(`stream-self-paused-${stream.trackName}`)).toBeNull();
    expect(screen.queryByText("Resume preview")).toBeNull();

    // Canvas changes only the tile's placement/props. The live video element itself must survive.
    rerender(
      <StreamTile
        stream={stream}
        selfStream={selfStream}
        fullscreen
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId(`stream-tile-${stream.trackName}`).getAttribute("data-preview-state"),
    ).toBe("live");
    expect(screen.getByTestId(`stream-self-${stream.trackName}`)).toBe(video);
    expect(screen.queryByTestId(`stream-self-paused-${stream.trackName}`)).toBeNull();
    expect(screen.queryByText("Resume preview")).toBeNull();
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
