import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Platform bridge double (§9.1 test-double casts). Each test mutates kind/os and the capture probes
// before rendering, so one SharePickerDialog can exercise the desktop, linux, and web variants.
const platformMock = vi.hoisted(() => ({
  kind: "desktop" as "desktop" | "web",
  os: "darwin" as "win32" | "darwin" | "linux" | "web",
  capture: {
    getScreenSources: vi.fn(
      async () => [] as { id: string; name: string; thumbnailDataUrl: string }[],
    ),
    selectSource: vi.fn(async () => undefined),
    loopbackAudioSupported: vi.fn(async () => true),
  },
}));
vi.mock("@/platform/types", () => ({ platform: platformMock }));

import { SharePickerDialog } from "@/features/streams/SharePickerDialog";

function renderPicker(): { onStart: ReturnType<typeof vi.fn> } {
  const onStart = vi.fn();
  render(<SharePickerDialog open onOpenChange={vi.fn()} onStart={onStart} />);
  return { onStart };
}

beforeEach(() => {
  platformMock.kind = "desktop";
  platformMock.os = "darwin";
  platformMock.capture.getScreenSources.mockResolvedValue([]);
  platformMock.capture.selectSource.mockResolvedValue(undefined);
  platformMock.capture.loopbackAudioSupported.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FR-28 share picker", () => {
  it("desktop: selecting a source arms selectSource with its id", async () => {
    platformMock.capture.getScreenSources.mockResolvedValue([
      { id: "screen:0", name: "Screen 1", thumbnailDataUrl: "data:image/png;base64," },
    ]);
    renderPicker();

    fireEvent.click(await screen.findByTestId("share-source-screen:0"));

    expect(platformMock.capture.selectSource).toHaveBeenCalledWith("screen:0");
  });

  it("preset select exposes exactly the 12 §App-D presets, default 1080p30", async () => {
    renderPicker();
    const trigger = await screen.findByTestId("share-preset");
    // §App-D default screen preset is 1080p30, shown in the closed trigger.
    expect(trigger.textContent).toContain("1080p · 30fps");

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByTestId("preset-option-1080p30")).not.toBeNull());
    expect(document.querySelectorAll('[data-testid^="preset-option-"]')).toHaveLength(12);
  });

  it("audio switch disabled when loopbackAudioSupported=false", async () => {
    platformMock.capture.loopbackAudioSupported.mockResolvedValue(false);
    renderPicker();

    // Base UI expresses the disabled state via data-disabled (not a native `disabled` property).
    const audio = await screen.findByTestId("share-audio");
    await waitFor(() => expect(audio.getAttribute("data-disabled")).not.toBeNull());
  });

  it("audio switch absent on linux", async () => {
    platformMock.os = "linux";
    renderPicker();

    await screen.findByTestId("share-preset");
    expect(screen.queryByTestId("share-audio")).toBeNull();
  });

  it("web: no source grid rendered", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    renderPicker();

    await screen.findByTestId("share-preset");
    expect(screen.queryByTestId("share-tab-screens")).toBeNull();
    expect(document.querySelector('[data-testid^="share-source-"]')).toBeNull();
  });
});
