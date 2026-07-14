import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareUsageResponse, UserProfile } from "@tavern/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

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

const auth = vi.hoisted(() => ({ logout: vi.fn(), pending: false }));
vi.mock("@/features/auth/useAuth", () => ({ useAuth: () => auth }));
vi.mock("@/features/market/MarketIconPicker", () => ({
  MarketIconPicker: () => <div data-testid="market-icon-picker" />,
}));

import { apiClient } from "@/lib/apiClient";
import { setLocale as setParaglideLocale } from "@/paraglide/runtime.js";
import { AccountSettingsDialog } from "@/features/settings/AccountSettingsDialog";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { automaticVoiceAvatarConfig } from "@/features/home/voiceAvatarScene";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { resetRoomStores, roomStore } from "@/stores/room";

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

const CUSTOM_VOICE_AVATAR = {
  version: 2,
  skinTone: "deep",
  hairColor: "blonde",
  hairStyle: "bun",
  eyeColor: "blue",
  glassesStyle: "square",
  facialHairStyle: "goatee",
  outfitColor: "#f87171",
} as const;

const CLOUDFLARE_USAGE: CloudflareUsageResponse = {
  periodStart: Date.UTC(2026, 6, 1),
  periodEnd: Date.UTC(2026, 6, 14),
  media: {
    status: "ready",
    updatedAt: Date.UTC(2026, 6, 14, 10),
    bytes: 3_002_005,
    objectCount: 3,
    categories: [
      { category: "avatars", bytes: 2_000, objectCount: 1 },
      { category: "soundboardAudio", bytes: 0, objectCount: 0 },
      { category: "recordings", bytes: 0, objectCount: 0 },
      { category: "screenshots", bytes: 3_000_000, objectCount: 1 },
      { category: "chatImages", bytes: 5, objectCount: 1 },
      { category: "other", bytes: 0, objectCount: 0 },
    ],
    reconciledAt: Date.UTC(2026, 6, 14, 10),
  },
  r2: { status: "ready", updatedAt: Date.UTC(2026, 6, 14, 10), operations: 10 },
  d1: {
    status: "ready",
    updatedAt: Date.UTC(2026, 6, 14, 10),
    storageBytes: 1_000,
    rowsRead: 20,
    rowsWritten: 5,
  },
  durableObjects: {
    status: "unavailable",
    updatedAt: null,
    requests: null,
    cpuTimeMs: null,
    storageBytes: null,
  },
  worker: { status: "unavailable", updatedAt: null, requests: null, errors: null, cpuTimeMs: null },
  turn: { status: "unavailable", updatedAt: null, ingressBytes: null, egressBytes: null },
  analyticsEngine: { status: "unavailable", updatedAt: null, pointsWritten: null },
  sfu: { status: "unavailable", updatedAt: null },
  rateLimiter: { status: "unavailable", updatedAt: null },
  staticAssets: { status: "unavailable", updatedAt: null },
};

beforeEach(() => {
  setParaglideLocale("en", { reload: false });
  resetRoomStores();
  roomStore("settings-server").setState({
    cost: { usedGB: 123.4, capGB: 900, blocked: false },
  });
  useSessionStore.setState({ status: "authed", profile: PROFILE });
  useSettingsStore.setState({
    theme: "system",
    locale: "en",
    notifyAll: true,
    notifyMentions: true,
  });
  document.documentElement.classList.remove("dark");
  vi.clearAllMocks();
  auth.pending = false;
  vi.mocked(apiClient.patch).mockResolvedValue({ ...PROFILE, displayName: "New Name" });
  vi.mocked(apiClient.put).mockResolvedValue({
    notifyAll: false,
    notifyMentions: true,
    locale: "en",
    theme: "system",
  });
  vi.mocked(apiClient.get).mockResolvedValue(CLOUDFLARE_USAGE);
});

afterEach(() => {
  cleanup();
});

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <SettingsDialog serverId="settings-server" open onOpenChange={() => undefined} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function renderAccountDialog(onOpenChange: (open: boolean) => void = () => undefined) {
  return render(
    <MemoryRouter>
      <AccountSettingsDialog serverId="settings-server" open onOpenChange={onOpenChange} />
    </MemoryRouter>,
  );
}

describe("FR-03 FR-04 FR-06 FR-07 settings", () => {
  it("save sends dirty-profile PATCH payload only", async () => {
    renderAccountDialog();
    fireEvent.change(await screen.findByTestId("input-display-name"), {
      target: { value: "New Name" },
    });
    fireEvent.click(screen.getByTestId("settings-account-save"));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect(apiClient.patch).toHaveBeenCalledWith("/api/me/profile", expect.anything(), {
      displayName: "New Name",
    });
  });

  it("closes the account dialog after a successful save", async () => {
    const onOpenChange = vi.fn();
    renderAccountDialog(onOpenChange);
    fireEvent.change(await screen.findByTestId("input-display-name"), {
      target: { value: "New Name" },
    });
    fireEvent.click(screen.getByTestId("settings-account-save"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("invalid hex blocks save with errors.color_invalid", async () => {
    renderAccountDialog();
    fireEvent.change(await screen.findByTestId("input-color"), { target: { value: "#zzzzzz" } });
    fireEvent.click(screen.getByTestId("settings-account-save"));
    await screen.findByTestId("error-color");
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("previews avatar parts locally and saves one complete recipe", async () => {
    renderAccountDialog();
    const automatic = automaticVoiceAvatarConfig(PROFILE.userId, PROFILE.color);
    fireEvent.click(await screen.findByTestId("voice-avatar-skin-ebony"));
    fireEvent.click(screen.getByTestId("voice-avatar-hair-color-ginger"));
    fireEvent.click(screen.getByTestId("voice-avatar-hair-style-wavy"));
    fireEvent.click(screen.getByTestId("voice-avatar-eye-color-green"));
    fireEvent.click(screen.getByTestId("voice-avatar-glasses-aviator"));
    fireEvent.click(screen.getByTestId("voice-avatar-facial-hair-mustache"));
    fireEvent.click(screen.getByTestId("voice-avatar-outfit-#1e3a8a"));
    fireEvent.click(screen.getByTestId("settings-account-save"));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/me/profile", expect.anything(), {
        voiceAvatar: {
          ...automatic,
          skinTone: "ebony",
          hairColor: "ginger",
          hairStyle: "wavy",
          eyeColor: "green",
          glassesStyle: "aviator",
          facialHairStyle: "mustache",
          outfitColor: "#1e3a8a",
        },
      }),
    );
  });

  it("hydrates a saved voice avatar and can restore automatic generation", async () => {
    useSessionStore.setState({
      status: "authed",
      profile: { ...PROFILE, voiceAvatar: CUSTOM_VOICE_AVATAR },
    });
    renderAccountDialog();
    expect((await screen.findByTestId("voice-avatar-skin-deep")).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("voice-avatar-hair-style-bun").getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByTestId("voice-avatar-use-automatic"));
    fireEvent.click(screen.getByTestId("settings-account-save"));
    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/me/profile", expect.anything(), {
        voiceAvatar: null,
      }),
    );
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

  it("shows server traffic usage in the App tab", async () => {
    renderDialog();
    fireEvent.click(await screen.findByTestId("settings-tab-tavern-usage"));
    const usage = (await screen.findByTestId("settings-egress-used")).textContent ?? "";
    expect(usage).toContain("123.4");
    expect(usage).toContain("900");
  });

  it("shows exact R2 media inventory and labels the egress figure as an estimate", async () => {
    renderDialog();
    fireEvent.click(await screen.findByTestId("settings-tab-tavern-usage"));
    const cloudflareUsage = await screen.findByTestId("settings-cloudflare-usage");
    await waitFor(() => expect(cloudflareUsage.textContent).toContain("3.0 MB"));
    expect(cloudflareUsage.textContent).toContain("Tavern Cloudflare usage");
    expect(screen.getByText("Estimated screen-share egress for this server")).not.toBeNull();
  });

  it("does not show the desktop close behavior in the web app", async () => {
    renderDialog();
    fireEvent.click(await screen.findByTestId("settings-tab-app"));
    expect(screen.queryByTestId("settings-close-to-tray")).toBeNull();
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

  it("renders independent sidebar and content scroll regions", () => {
    renderDialog();
    expect(screen.getByTestId("settings-sidebar-scroll")).not.toBeNull();
    expect(screen.getByTestId("settings-content-scroll")).not.toBeNull();
    expect(screen.getByTestId("settings-logout")).not.toBeNull();
  });

  it("uses the settings-sidebar logout action", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("settings-logout"));
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it("places the avatar preview above the profile fields", () => {
    renderAccountDialog();
    const preview = screen.getByTestId("settings-account-avatar");
    const displayName = screen.getByTestId("input-display-name");
    expect(
      preview.compareDocumentPosition(displayName) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(preview.textContent).toBe("A");
  });
});
