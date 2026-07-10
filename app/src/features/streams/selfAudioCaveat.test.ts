import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the sonner toast so the one-shot behaviour is observable without a mounted Toaster.
const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));

import { showSelfAudioCaveatOnce } from "@/features/streams/useScreenShare";

beforeEach(() => {
  localStorage.clear();
  toast.mockClear();
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
});
