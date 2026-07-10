import type { StreamInfo } from "@tavern/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamTile } from "@/features/streams/StreamTile";
import { useSettingsStore } from "@/stores/settings";

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
    render(<StreamTile stream={stream} focused={false} onToggleFocus={vi.fn()} />);

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
      />,
    );
    expect(screen.queryByTestId(`stream-volume-${UID}:screen`)).toBeNull();
  });
});

// A stateful wrapper mirroring Canvas: double-clicking the tile toggles `focused`, whose change the
// tile reacts to by switching simulcast layers (FR-33).
function FocusHarness({ stream }: { stream: StreamInfo }) {
  const [focused, setFocused] = useState(false);
  return (
    <StreamTile stream={stream} focused={focused} onToggleFocus={() => setFocused((f) => !f)} />
  );
}

describe("FR-33 focus layer", () => {
  it("double-click watched tile enters focus and calls setLayer h", () => {
    const stream = makeStream();
    render(<FocusHarness stream={stream} />);

    fireEvent.doubleClick(screen.getByTestId(`stream-tile-${stream.trackName}`));

    expect(watchMock.setLayer).toHaveBeenCalledWith("h");
  });

  it("second double-click (or Esc) leaves focus, calls setLayer l and restores grid", () => {
    const stream = makeStream();
    render(<FocusHarness stream={stream} />);
    const tile = screen.getByTestId(`stream-tile-${stream.trackName}`);

    fireEvent.doubleClick(tile); // enter focus → 'h'
    watchMock.setLayer.mockClear();
    fireEvent.doubleClick(tile); // leave focus → 'l'

    expect(watchMock.setLayer).toHaveBeenCalledWith("l");
    expect(tile.getAttribute("data-watching")).toBe("true");
  });
});
