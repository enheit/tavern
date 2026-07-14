import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sound } from "@tavern/shared";
import { SoundEditorDialog } from "@/features/soundboard/SoundEditorDialog";
import type { SoundWaveformFactory } from "@/features/soundboard/SoundEditorDialog";

const { controller } = vi.hoisted(() => ({
  controller: {
    previewSoundFile: vi.fn(
      async (
        _serverId: string,
        _bytes: ArrayBuffer,
        _sound: { trimStartMs: number; trimEndMs: number; gain: number },
        onStarted?: () => void,
      ) => {
        onStarted?.();
      },
    ),
    stopSoundboardPreview: vi.fn(),
  },
}));

vi.mock("@/features/voice/voiceController", () => ({
  getVoiceController: () => controller,
}));

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: ({
    children,
    onEmojiSelect,
  }: {
    children: ReactNode;
    onEmojiSelect(picked: { emoji: string }): void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="pick-test-emoji"
        onClick={() => onEmojiSelect({ emoji: "🎺" })}
      >
        pick
      </button>
      {children}
    </div>
  ),
  EmojiPickerSearch: () => null,
  EmojiPickerContent: () => null,
  EmojiPickerFooter: () => null,
}));

function waveformSeam(): {
  factory: SoundWaveformFactory;
  setPlayhead: ReturnType<typeof vi.fn>;
  setZoom: ReturnType<typeof vi.fn>;
  change(region: { startSec: number; endSec: number }): void;
} {
  const holder: { change: ((region: { startSec: number; endSec: number }) => void) | null } = {
    change: null,
  };
  const setPlayhead = vi.fn();
  const setZoom = vi.fn();
  return {
    factory: ({ onRegionChange }) => {
      holder.change = onRegionChange;
      return { setPlayhead, setZoom, destroy: vi.fn() };
    },
    setPlayhead,
    setZoom,
    change(region) {
      if (holder.change === null) throw new Error("waveform not initialized");
      act(() => holder.change?.(region));
    },
  };
}

function sound(): Sound {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Original",
    emoji: "🔊",
    gain: 1,
    sourceFileName: "original.mp3",
    uploaderId: "22222222-2222-4222-8222-222222222222",
    durationMs: 5000,
    trimStartMs: 500,
    trimEndMs: 4500,
    createdAt: 1,
    playCount: 8,
  };
}

function previewNotStarted(): never {
  throw new Error("preview did not start");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("sound editor", () => {
  it("creates with a dropped file, emoji, trim ratios, and gain", async () => {
    const onCreate = vi.fn(async () => undefined);
    const seam = waveformSeam();
    render(
      <SoundEditorDialog
        open
        serverId="server-1"
        sound={null}
        onOpenChange={vi.fn()}
        onCreate={onCreate}
        onPatch={vi.fn(async () => undefined)}
        onReplace={vi.fn(async () => undefined)}
        measureDurationMs={vi.fn(async () => 4000)}
        createWaveform={seam.factory}
      />,
    );
    const file = new File([new Uint8Array([0x49, 0x44, 0x33])], "Horn.mp3", {
      type: "audio/mpeg",
    });
    fireEvent.change(screen.getByTestId("sound-editor-file"), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId("sound-editor-name")).toHaveProperty("value", "Horn"),
    );
    fireEvent.click(screen.getByTestId("sound-editor-emoji"));
    fireEvent.click(screen.getByTestId("pick-test-emoji"));
    seam.change({ startSec: 0.5, endSec: 3.5 });
    const volume = screen
      .getByTestId("sound-editor-volume")
      .querySelector<HTMLInputElement>('input[type="range"]');
    if (volume === null) throw new Error("volume input not found");
    fireEvent.change(volume, { target: { value: "150" } });
    fireEvent.click(screen.getByTestId("sound-editor-save"));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({
      file,
      name: "Horn",
      emoji: "🎺",
      gain: 1.5,
      durationMs: 4000,
      trimStartRatio: 0.125,
      trimEndRatio: 0.875,
    });
  });

  it("loads the retained original and saves an extended metadata trim without replacing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200 })),
    );
    const onPatch = vi.fn(async () => undefined);
    const onReplace = vi.fn(async () => undefined);
    const seam = waveformSeam();
    const existing = sound();
    render(
      <SoundEditorDialog
        open
        serverId="server-1"
        sound={existing}
        onOpenChange={vi.fn()}
        onCreate={vi.fn(async () => undefined)}
        onPatch={onPatch}
        onReplace={onReplace}
        createWaveform={seam.factory}
      />,
    );
    await waitFor(() => expect(screen.getByText("original.mp3")).toBeDefined());
    fireEvent.change(screen.getByTestId("sound-editor-name"), { target: { value: "Extended" } });
    seam.change({ startSec: 0.1, endSec: 4.9 });
    fireEvent.click(screen.getByTestId("sound-editor-save"));

    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith(existing.id, {
        name: "Extended",
        emoji: "🔊",
        gain: 1,
        trimStartMs: 100,
        trimEndMs: 4900,
      }),
    );
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("zooms the waveform and drives a preview playhead from the actual playback start", async () => {
    const frames: FrameRequestCallback[] = [];
    let previewStarted = false;
    let finishPreview: () => void = previewNotStarted;
    controller.previewSoundFile.mockImplementationOnce(
      async (_serverId, _bytes, _sound, onStarted) =>
        new Promise<void>((resolve) => {
          previewStarted = true;
          finishPreview = resolve;
          onStarted?.();
        }),
    );
    const seam = waveformSeam();
    render(
      <SoundEditorDialog
        open
        serverId="server-1"
        sound={null}
        onOpenChange={vi.fn()}
        onCreate={vi.fn(async () => undefined)}
        onPatch={vi.fn(async () => undefined)}
        onReplace={vi.fn(async () => undefined)}
        measureDurationMs={vi.fn(async () => 4000)}
        createWaveform={seam.factory}
      />,
    );
    const file = new File([new Uint8Array([0x49, 0x44, 0x33])], "Preview.mp3", {
      type: "audio/mpeg",
    });
    fireEvent.change(screen.getByTestId("sound-editor-file"), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId("sound-editor-zoom-level").textContent).toBe("1×"),
    );

    fireEvent.click(screen.getByTestId("sound-editor-zoom-in"));
    expect(screen.getByTestId("sound-editor-zoom-level").textContent).toBe("2×");
    expect(seam.setZoom).toHaveBeenLastCalledWith(2);

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    fireEvent.click(screen.getByTestId("sound-editor-preview"));
    await waitFor(() => expect(controller.previewSoundFile).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("sound-editor-preview").textContent).toContain("Stop preview");
    expect(seam.setPlayhead).toHaveBeenCalledWith(0);
    const frame = frames.shift();
    if (frame === undefined) throw new Error("preview frame was not scheduled");
    act(() => frame(performance.now() + 500));
    expect(seam.setPlayhead.mock.calls.some(([time]) => typeof time === "number" && time > 0)).toBe(
      true,
    );

    expect(previewStarted).toBe(true);
    controller.stopSoundboardPreview.mockImplementationOnce(finishPreview);
    fireEvent.click(screen.getByTestId("sound-editor-preview"));
    expect(controller.stopSoundboardPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("sound-editor-preview").textContent).toContain("Preview");
    await waitFor(() => expect(seam.setPlayhead).toHaveBeenLastCalledWith(null));
  });
});
