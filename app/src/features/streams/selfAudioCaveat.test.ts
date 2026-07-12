import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenCapture } from "@/media/capture";

// Capture the sonner toast so the one-shot behaviour is observable without a mounted Toaster.
const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));

// Togglable platform seam: which notice fires depends on kind/os and on whether OS loopback
// already excludes Tavern's own audio (Windows 20348+/macOS "loopbackWithoutChrome").
const platformState = vi.hoisted(() => ({
  selfAudioExcluded: false,
  kind: "desktop" as "desktop" | "web",
  os: "win32" as "win32" | "darwin" | "linux" | "web",
}));
vi.mock("@/platform/types", () => ({
  platform: {
    get kind() {
      return platformState.kind;
    },
    isE2E: false,
    get os() {
      return platformState.os;
    },
    capture: {
      get loopbackSelfAudioExcluded() {
        return platformState.selfAudioExcluded;
      },
      prepareStreamAudio: async () => false,
      releaseStreamAudio: () => undefined,
    },
  },
}));

import { showShareAudioNotice } from "@/features/streams/useScreenShare";
import { useSettingsStore } from "@/stores/settings";

// exactOptionalPropertyTypes: clearing the pref means DELETING the key, not writing undefined.
function setStreamAudio(streamAudio: string | undefined): void {
  const settings = useSettingsStore.getState();
  const next = { ...settings.deviceSettings };
  delete next.streamAudio;
  if (streamAudio !== undefined) next.streamAudio = streamAudio;
  settings.setDeviceSettings(next);
}

// notice() never touches the tracks — §9.1 test-double cast.
function capture(audioSource: ScreenCapture["audioSource"], tabAudio = false): ScreenCapture {
  return {
    video: {} as MediaStreamTrack,
    audio: audioSource === null ? null : ({} as MediaStreamTrack),
    audioSource,
    tabAudio,
  };
}

beforeEach(() => {
  localStorage.clear();
  toast.mockClear();
  platformState.selfAudioExcluded = false;
  platformState.kind = "desktop";
  platformState.os = "win32";
  setStreamAudio(undefined);
});

describe("FR-28 share-audio notices", () => {
  it("display audio (non-tab): caveat fires once then never again (localStorage flag)", () => {
    showShareAudioNotice(capture("display"), true);
    expect(toast).toHaveBeenCalledTimes(1);

    showShareAudioNotice(capture("display"), true);
    showShareAudioNotice(capture("display"), true);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tavern.selfAudioCaveatShown.v1")).toBe("1");
  });

  it("display audio: never fires when loopback excludes Tavern's own audio (the caveat would be a lie)", () => {
    platformState.selfAudioExcluded = true;
    showShareAudioNotice(capture("display"), true);
    showShareAudioNotice(capture("display"), true);
    expect(toast).not.toHaveBeenCalled();
    expect(localStorage.getItem("tavern.selfAudioCaveatShown.v1")).toBeNull();
  });

  it("tab audio carries only that tab — no caveat", () => {
    showShareAudioNotice(capture("display", true), true);
    expect(toast).not.toHaveBeenCalled();
  });

  it("monitor fallback: filtered-voices note fires once under its own flag", () => {
    showShareAudioNotice(capture("monitor"), true);
    showShareAudioNotice(capture("monitor"), true);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tavern.systemAudioNoteShown.v1")).toBe("1");
    // the display caveat's flag is untouched — different notice, different lifecycle.
    expect(localStorage.getItem("tavern.selfAudioCaveatShown.v1")).toBeNull();
  });

  it("wanted audio but none captured (web): hint fires per share, no flag", () => {
    platformState.kind = "web";
    platformState.os = "web";
    showShareAudioNotice(capture(null), true);
    showShareAudioNotice(capture(null), true);
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("no hint when the user turned the fallback off, didn't want audio, or the OS has loopback", () => {
    platformState.kind = "web";
    platformState.os = "web";
    setStreamAudio("off");
    showShareAudioNotice(capture(null), true); // fallback off
    setStreamAudio(undefined);
    showShareAudioNotice(capture(null), false); // audio never wanted
    platformState.kind = "desktop";
    platformState.os = "win32";
    showShareAudioNotice(capture(null), true); // win32 desktop: loopback exists, hint is web/linux-only
    expect(toast).not.toHaveBeenCalled();
  });
});
