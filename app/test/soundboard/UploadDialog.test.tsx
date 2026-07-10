import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { m } from "@/paraglide/messages.js";
import { UploadDialog } from "@/features/soundboard/UploadDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mp3File(): File {
  return new File([new Uint8Array([0x49, 0x44, 0x33, 0x04])], "clip.mp3", { type: "audio/mpeg" });
}

function renderDialog(
  overrides: {
    onUpload?: (input: { file: File; name: string; durationMs: number }) => Promise<unknown>;
    measureDurationMs?: (file: File) => Promise<number>;
  } = {},
): {
  onUpload: (input: { file: File; name: string; durationMs: number }) => Promise<unknown>;
} {
  const onUpload = overrides.onUpload ?? vi.fn(async () => undefined);
  render(
    <UploadDialog
      open
      onOpenChange={vi.fn()}
      onUpload={onUpload}
      measureDurationMs={overrides.measureDurationMs ?? (async () => 1000)}
    />,
  );
  return { onUpload };
}

describe("FR-34 upload dialog", () => {
  it("rejects a clip longer than 5 minutes before uploading", async () => {
    const onUpload = vi.fn(async () => undefined);
    // Stub the decode seam to report 360 s — no big fixture needed.
    renderDialog({ onUpload, measureDurationMs: async () => 360_000 });

    fireEvent.change(screen.getByTestId("upload-file"), { target: { files: [mp3File()] } });
    fireEvent.change(screen.getByTestId("upload-name"), { target: { value: "toolong" } });
    fireEvent.click(screen.getByTestId("upload-submit"));

    const error = await screen.findByTestId("upload-error");
    expect(error.textContent).toBe(m.soundboard_upload_too_long());
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("submits name + durationMs for a valid file", async () => {
    const onUpload = vi.fn(async () => undefined);
    const file = mp3File();
    renderDialog({ onUpload, measureDurationMs: async () => 1500 });

    fireEvent.change(screen.getByTestId("upload-file"), { target: { files: [file] } });
    fireEvent.change(screen.getByTestId("upload-name"), { target: { value: "boop" } });
    fireEvent.click(screen.getByTestId("upload-submit"));

    await waitFor(() =>
      expect(onUpload).toHaveBeenCalledWith({ file, name: "boop", durationMs: 1500 }),
    );
  });

  it("name over 32 chars shows inline error", async () => {
    const onUpload = vi.fn(async () => undefined);
    renderDialog({ onUpload });

    fireEvent.change(screen.getByTestId("upload-file"), { target: { files: [mp3File()] } });
    fireEvent.change(screen.getByTestId("upload-name"), { target: { value: "x".repeat(33) } });
    fireEvent.click(screen.getByTestId("upload-submit"));

    const error = await screen.findByTestId("upload-name-error");
    expect(error.textContent).toBe(m.soundboard_upload_name_invalid());
    expect(onUpload).not.toHaveBeenCalled();
  });
});
