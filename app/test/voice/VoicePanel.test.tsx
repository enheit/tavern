import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/voice/useVoice", () => ({ useVoice: vi.fn() }));
// The recorder module pulls in the media stack; the leave flow only needs the no-op stopRecording.
vi.mock("@/features/recordings/RecordButton", () => ({
  stopRecording: vi.fn(async () => undefined),
}));

import { VoicePanel } from "@/features/voice/VoicePanel";
import { useVoice } from "@/features/voice/useVoice";

const SID = "s-voice";

const leave = vi.fn(async () => undefined);
const setMuted = vi.fn();
const setDeafened = vi.fn();

function mockVoice(over: {
  status?: "idle" | "joined";
  inVoiceServerId?: string | null;
  muted?: boolean;
  deafened?: boolean;
}): void {
  vi.mocked(useVoice).mockReturnValue({
    join: vi.fn(async () => undefined),
    leave,
    status: over.status ?? "idle",
    inVoiceServerId: over.inVoiceServerId ?? null,
    muted: over.muted ?? false,
    setMuted,
    deafened: over.deafened ?? false,
    setDeafened,
  });
}

beforeEach(() => {
  leave.mockClear();
  setMuted.mockClear();
  setDeafened.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("VoicePanel", () => {
  it("renders nothing when not in voice on this server", () => {
    mockVoice({ status: "idle", inVoiceServerId: null });
    render(<VoicePanel serverId={SID} />);
    expect(screen.queryByTestId("voice-panel")).toBeNull();
  });

  it("renders nothing while in voice on a DIFFERENT server", () => {
    mockVoice({ status: "joined", inVoiceServerId: "other" });
    render(<VoicePanel serverId={SID} />);
    expect(screen.queryByTestId("voice-panel")).toBeNull();
  });

  it("shows only the leave button when joined here — mute/deafen live in the ControlsBar", () => {
    mockVoice({ status: "joined", inVoiceServerId: SID });
    render(<VoicePanel serverId={SID} />);

    expect(screen.getByTestId("voice-panel")).toBeTruthy();
    expect(screen.getByTestId("controls-leave")).toBeTruthy();
    expect(screen.queryByTestId("controls-mute")).toBeNull();
    expect(screen.queryByTestId("controls-deafen")).toBeNull();
    expect(screen.queryByText(/connected/i)).toBeNull();
  });

  it("leave button leaves voice", async () => {
    mockVoice({ status: "joined", inVoiceServerId: SID });
    render(<VoicePanel serverId={SID} />);

    fireEvent.click(screen.getByTestId("controls-leave"));
    // onLeave awaits stopRecording (mocked no-op) before leave — flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
