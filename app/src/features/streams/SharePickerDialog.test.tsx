import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Platform bridge double (§9.1 test-double casts). Each test mutates kind/os and the capture probes
// before rendering, so one SharePickerDialog can exercise the desktop, linux, and web variants.
const platformMock = vi.hoisted(() => ({
  kind: "desktop" as "desktop" | "web",
  os: "darwin" as "win32" | "darwin" | "linux" | "web",
  capture: {
    sourceMode: "grid" as "grid" | "portal",
    getScreenSources: vi.fn(
      async () => [] as { id: string; name: string; thumbnailDataUrl: string }[],
    ),
    selectSource: vi.fn(async () => undefined),
    loopbackAudioSupported: vi.fn(async () => true),
    screenAccessStatus: vi.fn(async () => "granted"),
    openScreenRecordingSettings: vi.fn(() => undefined),
  },
}));
vi.mock("@/platform/types", () => ({ platform: platformMock }));

import { SharePickerDialog } from "@/features/streams/SharePickerDialog";

function renderPicker(initialPreset?: "1080p30-50"): { onStart: ReturnType<typeof vi.fn> } {
  const onStart = vi.fn();
  render(
    <SharePickerDialog
      open
      onOpenChange={vi.fn()}
      onStart={onStart}
      {...(initialPreset === undefined ? {} : { initialPreset })}
    />,
  );
  return { onStart };
}

beforeEach(() => {
  platformMock.kind = "desktop";
  platformMock.os = "darwin";
  platformMock.capture.sourceMode = "grid";
  platformMock.capture.getScreenSources.mockResolvedValue([]);
  platformMock.capture.selectSource.mockResolvedValue(undefined);
  platformMock.capture.loopbackAudioSupported.mockResolvedValue(true);
  platformMock.capture.screenAccessStatus.mockResolvedValue("granted");
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

  it("selects the data tier before capture", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    const { onStart } = renderPicker("1080p30-50");

    expect((await screen.findByTestId("share-data-tier")).textContent).toContain("50%");
    fireEvent.click(screen.getByTestId("share-start"));
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ preset: "1080p30-50", sourceId: null }),
    );
  });

  it("desktop always requests audio and does not expose an audio switch", async () => {
    platformMock.capture.getScreenSources.mockResolvedValue([
      { id: "screen:0", name: "Screen 1", thumbnailDataUrl: "data:image/png;base64," },
    ]);
    platformMock.capture.loopbackAudioSupported.mockResolvedValue(false);
    const { onStart } = renderPicker();

    fireEvent.click(await screen.findByTestId("share-source-screen:0"));
    expect(screen.queryByTestId("share-audio")).toBeNull();
    fireEvent.click(screen.getByTestId("share-start"));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "screen:0", withAudio: true }),
    );
    expect(platformMock.capture.loopbackAudioSupported).not.toHaveBeenCalled();
  });

  it("linux also always requests audio without an audio switch", async () => {
    platformMock.os = "linux";
    platformMock.capture.getScreenSources.mockResolvedValue([
      { id: "screen:0", name: "Screen 1", thumbnailDataUrl: "data:image/png;base64," },
    ]);
    platformMock.capture.loopbackAudioSupported.mockResolvedValue(false);
    const { onStart } = renderPicker();

    fireEvent.click(await screen.findByTestId("share-source-screen:0"));
    expect(screen.queryByTestId("share-audio")).toBeNull();
    fireEvent.click(screen.getByTestId("share-start"));

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ withAudio: true }));
  });

  it("web: no source grid rendered", async () => {
    platformMock.kind = "web";
    platformMock.os = "web";
    const { onStart } = renderPicker();

    await screen.findByTestId("share-preset");
    expect(screen.queryByTestId("share-tab-screens")).toBeNull();
    expect(document.querySelector('[data-testid^="share-source-"]')).toBeNull();
    expect(screen.queryByTestId("share-audio")).toBeNull();
    fireEvent.click(screen.getByTestId("share-start"));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ withAudio: true }));
  });

  it("desktop darwin: screen access denied replaces the tabs with the permission hint", async () => {
    platformMock.capture.screenAccessStatus.mockResolvedValue("denied");
    renderPicker();

    await screen.findByTestId("share-permission-hint");
    expect(screen.queryByTestId("share-tab-screens")).toBeNull();
    expect(screen.queryByTestId("share-tab-windows")).toBeNull();

    fireEvent.click(screen.getByTestId("share-open-settings"));
    expect(platformMock.capture.openScreenRecordingSettings).toHaveBeenCalledTimes(1);
  });

  it("desktop: granted access shows the tabs and no permission hint", async () => {
    platformMock.capture.getScreenSources.mockResolvedValue([
      { id: "screen:0", name: "Screen 1", thumbnailDataUrl: "data:image/png;base64," },
    ]);
    renderPicker();

    await screen.findByTestId("share-source-screen:0");
    expect(screen.queryByTestId("share-permission-hint")).toBeNull();
  });

  it("desktop wayland (portal mode): no grid, no enumeration, Start armed with the sentinel", async () => {
    // Wayland: enumeration ids die with each portal session AND every getSources pops the OS
    // dialog — the picker must not enumerate at all; the ScreenCast dialog is the picker.
    platformMock.os = "linux";
    platformMock.capture.sourceMode = "portal";
    const { onStart } = renderPicker();

    await screen.findByTestId("share-preset");
    expect(screen.queryByTestId("share-tab-screens")).toBeNull();
    expect(platformMock.capture.getScreenSources).not.toHaveBeenCalled();
    expect(platformMock.capture.screenAccessStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(platformMock.capture.selectSource).toHaveBeenCalledWith("portal"));

    const start = screen.getByTestId("share-start");
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "portal", withAudio: true }),
    );
  });
});
