import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the sonner toast so the one-shot behaviour is observable without a mounted Toaster.
const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));

// Togglable platform seam: the caveat is skipped entirely when capture excludes Tavern's own
// audio (Windows 20348+ "loopbackWithoutChrome").
const platformState = vi.hoisted(() => ({ selfAudioExcluded: false }));
vi.mock("@/platform/types", () => ({
  platform: {
    kind: "desktop",
    isE2E: false,
    os: "win32",
    capture: {
      get loopbackSelfAudioExcluded() {
        return platformState.selfAudioExcluded;
      },
    },
  },
}));

import { showSelfAudioCaveatOnce } from "@/features/streams/useScreenShare";

beforeEach(() => {
  localStorage.clear();
  toast.mockClear();
  platformState.selfAudioExcluded = false;
});

describe("FR-28 self-audio caveat", () => {
  it("toast fires once then never again (localStorage flag)", () => {
    showSelfAudioCaveatOnce();
    expect(toast).toHaveBeenCalledTimes(1);

    showSelfAudioCaveatOnce();
    showSelfAudioCaveatOnce();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tavern.selfAudioCaveatShown.v1")).toBe("1");
  });

  it("never fires when loopback excludes Tavern's own audio (the caveat would be a lie)", () => {
    platformState.selfAudioExcluded = true;
    showSelfAudioCaveatOnce();
    showSelfAudioCaveatOnce();
    expect(toast).not.toHaveBeenCalled();
    expect(localStorage.getItem("tavern.selfAudioCaveatShown.v1")).toBeNull();
  });
});
