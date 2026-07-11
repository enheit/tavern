import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/voice/useVoice", () => ({ useVoice: vi.fn() }));
vi.mock("@/features/streams/useScreenShare", () => ({ useScreenShare: vi.fn() }));
vi.mock("@/features/streams/useWebcam", () => ({ useWebcam: vi.fn() }));
// The record button + share dialog pull in the media/recorder stack; stub them to plain markers.
vi.mock("@/features/recordings/RecordButton", () => ({
  RecordButton: () => <div data-testid="controls-record" />,
}));
vi.mock("@/features/streams/SharePickerDialog", () => ({ SharePickerDialog: () => null }));

import { ControlsBar } from "@/features/shell/ControlsBar";
import { useScreenShare } from "@/features/streams/useScreenShare";
import { useWebcam } from "@/features/streams/useWebcam";
import { useVoice } from "@/features/voice/useVoice";

const SID = "s1";

const startShare = vi.fn(async () => undefined);
const stopShare = vi.fn(async () => undefined);
const startCam = vi.fn(async () => undefined);
const stopCam = vi.fn(async () => undefined);
const setMuted = vi.fn();
const setDeafened = vi.fn();

function mockVoice(active: boolean, over: { muted?: boolean; deafened?: boolean } = {}): void {
  vi.mocked(useVoice).mockReturnValue({
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    status: active ? "joined" : "idle",
    inVoiceServerId: active ? SID : null,
    muted: over.muted ?? false,
    setMuted,
    deafened: over.deafened ?? false,
    setDeafened,
  });
}

function mockMedia(over: { sharing?: boolean; camming?: boolean } = {}): void {
  vi.mocked(useScreenShare).mockReturnValue({
    sharing: over.sharing ?? false,
    preset: null,
    trackName: null,
    start: startShare,
    stop: stopShare,
    setPreset: vi.fn(async () => undefined),
  });
  vi.mocked(useWebcam).mockReturnValue({
    active: over.camming ?? false,
    start: startCam,
    stop: stopCam,
  });
}

beforeEach(() => {
  startShare.mockClear();
  stopShare.mockClear();
  startCam.mockClear();
  stopCam.mockClear();
  setMuted.mockClear();
  setDeafened.mockClear();
  mockMedia();
});

afterEach(() => {
  cleanup();
});

describe("ControlsBar", () => {
  it("has no join/leave buttons (join lives on the channel row, leave in the VoicePanel)", () => {
    mockVoice(true);
    render(<ControlsBar serverId={SID} />);

    for (const id of ["controls-join", "controls-leave"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.queryByText(/join voice/i)).toBeNull();
  });

  it("mute button reflects muted state and toggles it", () => {
    mockVoice(true, { muted: false });
    render(<ControlsBar serverId={SID} />);

    const mute = screen.getByTestId("controls-mute");
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(mute);
    expect(setMuted).toHaveBeenCalledWith(true);
  });

  it("deafen button reflects deafened state and toggles it", () => {
    mockVoice(true, { deafened: true });
    render(<ControlsBar serverId={SID} />);

    const deafen = screen.getByTestId("controls-deafen");
    expect(deafen.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(deafen);
    expect(setDeafened).toHaveBeenCalledWith(false);
  });

  it("hides the share/cam/record buttons while not in voice", () => {
    mockVoice(false);
    render(<ControlsBar serverId={SID} />);

    // The bar container stays (readiness signal) but the action buttons are gone.
    expect(screen.getByTestId("controls-bar")).toBeTruthy();
    expect(screen.queryByTestId("controls-screen")).toBeNull();
    expect(screen.queryByTestId("controls-cam")).toBeNull();
    expect(screen.queryByTestId("controls-record")).toBeNull();
  });

  it("shows icon-only screen/cam/record/mute/deafen buttons when in voice — no tuning groups while idle", () => {
    mockVoice(true);
    render(<ControlsBar serverId={SID} />);

    for (const id of [
      "controls-screen",
      "controls-cam",
      "controls-record",
      "controls-mute",
      "controls-deafen",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    // The segmented res/fps/data groups appear only while sharing (live tuning).
    expect(screen.queryByTestId("share-res-1080")).toBeNull();
    expect(screen.queryByTestId("share-fps-30")).toBeNull();
    expect(screen.queryByTestId("share-data-100")).toBeNull();
  });

  it("screen button starts sharing at the shown preset when idle (web — no dialog)", () => {
    mockVoice(true);
    render(<ControlsBar serverId={SID} />);

    fireEvent.click(screen.getByTestId("controls-screen"));
    expect(startShare).toHaveBeenCalledWith({
      sourceId: null,
      preset: "1080p30",
      withAudio: true,
    });
    expect(stopShare).not.toHaveBeenCalled();
  });

  it("while sharing the button stops and the res/fps/data tuning groups appear", () => {
    mockVoice(true);
    mockMedia({ sharing: true });
    render(<ControlsBar serverId={SID} />);

    // Live-tuning segmented groups: 4 resolutions × 3 fps × 4 data tiers, defaults selected.
    expect(screen.getByTestId("share-res-1080").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("share-fps-30").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("share-data-100").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTestId("controls-screen"));
    expect(stopShare).toHaveBeenCalledTimes(1);
    expect(startShare).not.toHaveBeenCalled();
  });
});
