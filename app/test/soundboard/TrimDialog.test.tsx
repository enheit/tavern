import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sound } from "@tavern/shared";
import { TrimDialog } from "@/features/soundboard/TrimDialog";
import type { WaveSurferFactory } from "@/features/soundboard/TrimDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function sound(over: Partial<Sound> = {}): Sound {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "clip",
    emoji: "🔊",
    gain: 1,
    sourceFileName: "clip.mp3",
    uploaderId: "22222222-2222-4222-8222-222222222222",
    durationMs: 5000,
    trimStartMs: 0,
    trimEndMs: 5000,
    createdAt: 1,
    playCount: 0,
    ...over,
  };
}

// A factory seam that captures the region-change callback so the test can drive it directly (no real
// wavesurfer / audio pipeline).
function mockFactory(): {
  factory: WaveSurferFactory;
  change(region: { startSec: number; endSec: number }): void;
} {
  const holder: { cb: ((r: { startSec: number; endSec: number }) => void) | null } = { cb: null };
  const factory: WaveSurferFactory = ({ onRegionChange }) => {
    holder.cb = onRegionChange;
    return { play: vi.fn(), destroy: vi.fn() };
  };
  return {
    factory,
    change(region) {
      const cb = holder.cb;
      if (cb === null) throw new Error("factory not initialized");
      act(() => cb(region));
    },
  };
}

describe("FR-35 trim dialog", () => {
  it("maps region seconds to whole ms on save", async () => {
    const onSave = vi.fn(async () => undefined);
    const seam = mockFactory();
    const s = sound();
    render(
      <TrimDialog
        open
        onOpenChange={vi.fn()}
        serverId="srv"
        sound={s}
        onSave={onSave}
        createWaveSurfer={seam.factory}
      />,
    );
    await screen.findByTestId("trim-waveform");

    seam.change({ startSec: 1.234, endSec: 3.678 });
    fireEvent.click(screen.getByTestId("trim-save"));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(s.id, { trimStartMs: 1234, trimEndMs: 3678 }),
    );
  });

  it("save disabled when window < soundMinTrimMs", async () => {
    const onSave = vi.fn(async () => undefined);
    const seam = mockFactory();
    render(
      <TrimDialog
        open
        onOpenChange={vi.fn()}
        serverId="srv"
        sound={sound()}
        onSave={onSave}
        createWaveSurfer={seam.factory}
      />,
    );
    await screen.findByTestId("trim-waveform");

    // 100ms window is below soundMinTrimMs (200) → save disabled.
    seam.change({ startSec: 1.0, endSec: 1.1 });

    const save = screen.getByTestId("trim-save");
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });
});
