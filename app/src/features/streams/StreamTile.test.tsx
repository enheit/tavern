import type { StreamInfo } from "@tavern/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamTile } from "@/features/streams/StreamTile";
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

// Base UI Slider drives value changes through a hidden native range input inside the thumb; a
// `change` event on it is what the component listens to (jsdom has no pointer geometry).
function setSlider(streamKey: string, percent: number): void {
  const input = screen
    .getByTestId(`stream-volume-${streamKey}`)
    .querySelector('input[type="range"]');
  if (input === null) throw new Error("no slider input");
  fireEvent.change(input, { target: { value: String(percent) } });
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
    render(
      <StreamTile
        stream={stream}
        focused={false}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(screen.getByTestId(`stream-kind-${stream.trackName}`)).not.toBeNull();
    // No video / volume in the placeholder.
    expect(screen.queryByTestId(`stream-video-${stream.trackName}`)).toBeNull();

    fireEvent.click(screen.getByTestId(`stream-watch-${stream.trackName}`));
    expect(watchMock.watch).toHaveBeenCalledTimes(1);
  });
});

describe("FR-31 per-stream volume", () => {
  it("slider maps 0–200% to setStreamGain 0–2 keyed by userId:kind", () => {
    const key = `${UID}:screen`;
    render(
      <StreamTile
        stream={makeStream({ hasAudio: true })}
        focused={false}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    setSlider(key, 200);
    expect(sinkMock.setStreamGain).toHaveBeenCalledWith(key, 2);

    setSlider(key, 0);
    expect(sinkMock.setStreamGain).toHaveBeenCalledWith(key, 0);
  });

  it("volume persists to settings.volumes.v1", () => {
    const key = `${UID}:screen`;
    render(
      <StreamTile
        stream={makeStream({ hasAudio: true })}
        focused={false}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    setSlider(key, 200);

    expect(useSettingsStore.getState().volumes.streams[key]).toBe(2);
  });

  it("slider absent when hasAudio=false", () => {
    render(
      <StreamTile
        stream={makeStream({ hasAudio: false })}
        focused={false}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(`stream-volume-${UID}:screen`)).toBeNull();
  });
});

// A stateful wrapper mirroring Canvas: clicking the tile toggles `focused`, whose change the
// tile reacts to by switching simulcast layers (FR-33).
function FocusHarness({ stream }: { stream: StreamInfo }) {
  const [focused, setFocused] = useState(false);
  return (
    <StreamTile
      stream={stream}
      focused={focused}
      onToggleFocus={() => setFocused((f) => !f)}
      onToggleFullscreen={vi.fn()}
    />
  );
}

describe("FR-27 preset dropdown removed from tiles (tuning lives in the ControlsBar)", () => {
  const self = { userId: UID, username: "me", displayName: "Me", color: "#abcdef" };

  it("dropdown is absent even on the sharer's OWN screen tile", () => {
    useSessionStore.setState({ profile: self });
    const stream = makeStream({ userId: UID, kind: "screen" });
    render(
      <StreamTile
        stream={stream}
        focused={false}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );
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
    render(
      <StreamTile
        stream={stream}
        focused={false}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(`stream-preset-${stream.trackName}`)).toBeNull();
  });

  it("dropdown is absent on ANOTHER member's screen tile", () => {
    useSessionStore.setState({ profile: self });
    const other = "33333333-3333-4333-8333-333333333333";
    const stream = makeStream({ userId: other, kind: "screen", trackName: `screen:${other}:1` });
    render(
      <StreamTile
        stream={stream}
        focused={false}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(`stream-preset-${stream.trackName}`)).toBeNull();
  });
});

describe("FR-33 focus layer", () => {
  it("click watched tile enters focus and calls setLayer h", () => {
    const stream = makeStream();
    render(<FocusHarness stream={stream} />);

    fireEvent.click(screen.getByTestId(`stream-tile-${stream.trackName}`));

    expect(watchMock.setLayer).toHaveBeenCalledWith("h");
  });

  it("second click (or Esc) leaves focus, calls setLayer l and restores grid", () => {
    const stream = makeStream();
    render(<FocusHarness stream={stream} />);
    const tile = screen.getByTestId(`stream-tile-${stream.trackName}`);

    fireEvent.click(tile); // enter focus → 'h'
    watchMock.setLayer.mockClear();
    fireEvent.click(tile); // leave focus → 'l'

    expect(watchMock.setLayer).toHaveBeenCalledWith("l");
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
        focused={false}
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

  it("own tiles never render a Watch button", () => {
    seedSelf();
    // Even with the watch engine idle, a self tile shows no Watch — you never pull your own stream.
    watchMock.state = "idle";
    const stream = makeStream({ kind: "webcam", trackName: `cam:${UID}` });
    render(
      <StreamTile
        stream={stream}
        selfStream={null}
        focused={false}
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
        focused={false}
        onToggleFocus={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(screen.getByTestId(`stream-watch-${stream.trackName}`)).not.toBeNull();
    expect(screen.getByTestId(`stream-kind-${stream.trackName}`)).not.toBeNull();
    expect(screen.queryByTestId(`stream-self-${stream.trackName}`)).toBeNull();
  });
});
