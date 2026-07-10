import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "@tavern/shared";

// Mock the REST seam; the stores + sections are real. apiClient.patch persists the profile,
// apiClient.put persists the settings row.
vi.mock("@/lib/apiClient", () => {
  class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  return {
    ApiError,
    apiClient: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
      upload: vi.fn(),
    },
  };
});

import { apiClient } from "@/lib/apiClient";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

// Base UI positioners use ResizeObserver / scrollIntoView (absent in jsdom) — test doubles.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeAll(() => {
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
  Reflect.set(Element.prototype, "scrollIntoView", () => undefined);
});

const PROFILE: UserProfile = {
  userId: crypto.randomUUID(),
  username: "alice",
  displayName: "Alice",
  color: "#aabbcc",
};

beforeEach(() => {
  useSessionStore.setState({ status: "authed", profile: PROFILE });
  useSettingsStore.setState({
    theme: "system",
    locale: "en",
    notifyAll: true,
    notifyMentions: true,
  });
  document.documentElement.classList.remove("dark");
  vi.clearAllMocks();
  vi.mocked(apiClient.patch).mockResolvedValue({ ...PROFILE, displayName: "New Name" });
  vi.mocked(apiClient.put).mockResolvedValue({
    notifyAll: false,
    notifyMentions: true,
    locale: "en",
    theme: "system",
  });
});

afterEach(() => {
  cleanup();
});

function renderDialog() {
  return render(<SettingsDialog open onOpenChange={() => undefined} />);
}

describe("FR-03 FR-04 FR-06 FR-07 settings", () => {
  it("save sends dirty-profile PATCH payload only", async () => {
    renderDialog();
    fireEvent.change(await screen.findByTestId("input-display-name"), {
      target: { value: "New Name" },
    });
    fireEvent.click(screen.getByTestId("settings-account-save"));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect(apiClient.patch).toHaveBeenCalledWith("/api/me/profile", expect.anything(), {
      displayName: "New Name",
    });
  });

  it("invalid hex blocks save with errors.color_invalid", async () => {
    renderDialog();
    fireEvent.change(await screen.findByTestId("input-color"), { target: { value: "#zzzzzz" } });
    fireEvent.click(screen.getByTestId("settings-account-save"));
    await screen.findByTestId("error-color");
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("theme radio applies html class instantly", async () => {
    renderDialog();
    fireEvent.click(await screen.findByTestId("settings-tab-app"));
    fireEvent.click(await screen.findByTestId("theme-option-dark"));
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  it("language select switches i18n language", async () => {
    renderDialog();
    fireEvent.click(await screen.findByTestId("settings-tab-app"));
    fireEvent.click(await screen.findByTestId("settings-language"));
    const uk = await screen.findByTestId("lang-option-uk");
    // Base UI's Select.Item commits a mouse selection only after a pointerdown armed it (its onClick
    // rejects unarmed synthetic clicks) — mirror the real pointerdown→click sequence.
    fireEvent.pointerDown(uk);
    fireEvent.click(uk);
    await waitFor(() => expect(useSettingsStore.getState().locale).toBe("uk"));
  });

  it("notification toggles PUT full settings row", async () => {
    renderDialog();
    fireEvent.click(await screen.findByTestId("settings-tab-notifications"));
    fireEvent.click(await screen.findByTestId("settings-notify-all"));
    await waitFor(() => expect(apiClient.put).toHaveBeenCalled());
    expect(apiClient.put).toHaveBeenCalledWith("/api/me/settings", expect.anything(), {
      notifyAll: false,
      notifyMentions: true,
      locale: "en",
      theme: "system",
    });
  });
});
