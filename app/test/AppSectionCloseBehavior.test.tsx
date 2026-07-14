import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeBehavior = vi.hoisted(() => ({
  getCloseToTray: vi.fn<() => Promise<boolean>>(),
  setCloseToTray: vi.fn<(value: boolean) => Promise<void>>(),
}));

vi.mock("@/platform/types", () => ({
  platform: { shell: { closeBehavior } },
}));

import { AppSection } from "@/features/settings/AppSection";

describe("desktop close behavior setting", () => {
  beforeEach(() => {
    closeBehavior.getCloseToTray.mockResolvedValue(true);
    closeBehavior.setCloseToTray.mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads as enabled by default and persists disabling it", async () => {
    render(<AppSection />);
    const toggle = await screen.findByTestId("settings-close-to-tray");
    await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));
    expect(toggle.hasAttribute("data-checked")).toBe(true);

    fireEvent.click(toggle);

    await waitFor(() => expect(closeBehavior.setCloseToTray).toHaveBeenCalledWith(false));
    await waitFor(() => expect(toggle.hasAttribute("data-unchecked")).toBe(true));
  });

  it("keeps the previous state when persistence fails", async () => {
    closeBehavior.setCloseToTray.mockRejectedValue(new Error("disk full"));
    render(<AppSection />);
    const toggle = await screen.findByTestId("settings-close-to-tray");
    await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));

    fireEvent.click(toggle);

    await waitFor(() => expect(closeBehavior.setCloseToTray).toHaveBeenCalledWith(false));
    expect(toggle.hasAttribute("data-checked")).toBe(true);
  });
});
