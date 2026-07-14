import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@tavern/shared";

vi.mock("@/features/voice/useVoice", () => ({ useVoice: vi.fn() }));

import { SidebarProfile } from "@/features/shell/SidebarProfile";
import { useVoice } from "@/features/voice/useVoice";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

const SERVER_ID = "settings-server";
const PROFILE = {
  userId: "00000000-0000-4000-8000-000000000001",
  username: "alice",
  displayName: "Alice",
  color: "#aabbcc",
};
const setMuted = vi.fn();
const setDeafened = vi.fn();

function selfMember(presence: Member["presence"]): Member {
  return { ...PROFILE, presence, isAdmin: false, joinedAt: 1 };
}

function mockVoice(
  over: { status?: "idle" | "joining"; muted?: boolean; deafened?: boolean } = {},
) {
  vi.mocked(useVoice).mockReturnValue({
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    status: over.status ?? "idle",
    inVoiceServerId: null,
    muted: over.muted ?? false,
    setMuted,
    deafened: over.deafened ?? false,
    setDeafened,
  });
}

beforeEach(() => {
  resetRoomStores();
  useSessionStore.setState({ status: "authed", profile: PROFILE, avatarRevision: 0 });
  setMuted.mockClear();
  setDeafened.mockClear();
  mockVoice();
});

afterEach(cleanup);

function renderProfile() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <SidebarProfile serverId={SERVER_ID} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("sidebar self profile", () => {
  it("shows the current display name in the selected color and a matching avatar fallback", () => {
    renderProfile();
    const name = screen.getByTestId("sidebar-profile-name");
    const avatar = screen.getByTestId("sidebar-profile-avatar");
    expect(name.textContent).toBe("Alice");
    expect(avatar.textContent).toBe("A");
    expect(name.style.color).toBe(avatar.style.backgroundColor);
    expect(screen.getByTestId("sidebar-profile-status").textContent).toBe("Offline");
    expect(screen.getByTestId("sidebar-profile-presence").getAttribute("data-presence")).toBe(
      "offline",
    );
  });

  it("uses the authoritative room presence for the avatar dot and status line", () => {
    roomStore(SERVER_ID).setState({ members: [selfMember("online")] });
    renderProfile();

    expect(screen.getByTestId("sidebar-profile-status").textContent).toBe("Online");
    expect(screen.getByTestId("sidebar-profile-presence").getAttribute("data-presence")).toBe(
      "online",
    );

    act(() => {
      roomStore(SERVER_ID).setState({ members: [selfMember("in-voice")] });
    });
    expect(screen.getByTestId("sidebar-profile-status").textContent).toContain("In voice");
    expect(screen.getByTestId("sidebar-profile-presence").getAttribute("data-presence")).toBe(
      "in-voice",
    );
  });

  it("keeps mirrored mute and deafen controls active before joining voice", () => {
    mockVoice({ muted: false, deafened: true });
    renderProfile();

    const mute = screen.getByTestId("sidebar-mute");
    const deafen = screen.getByTestId("sidebar-deafen");
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(deafen.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mute);
    fireEvent.click(deafen);
    expect(setMuted).toHaveBeenCalledWith(true);
    expect(setDeafened).toHaveBeenCalledWith(false);
  });

  it("disables voice toggles only during a voice transition", () => {
    mockVoice({ status: "joining" });
    renderProfile();
    expect(screen.getByTestId("sidebar-mute").getAttribute("disabled")).not.toBeNull();
    expect(screen.getByTestId("sidebar-deafen").getAttribute("disabled")).not.toBeNull();
  });

  it("refreshes an uploaded avatar through the session revision", () => {
    useSessionStore.setState({
      profile: { ...PROFILE, avatarKey: "avatars/alice.webp" },
      avatarRevision: 3,
    });
    renderProfile();
    const avatar = screen.getByTestId("sidebar-profile-avatar") as HTMLImageElement;
    expect(avatar.src).toContain("?v=3");

    act(() => {
      useSessionStore.getState().patchProfile({ avatarKey: "avatars/alice.webp" });
    });
    expect((screen.getByTestId("sidebar-profile-avatar") as HTMLImageElement).src).toContain(
      "?v=4",
    );
  });

  it("opens account settings from the avatar and nickname identity block", () => {
    renderProfile();
    fireEvent.click(screen.getByTestId("sidebar-profile-name"));
    expect(screen.getByTestId("account-settings-dialog")).not.toBeNull();
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
  });

  it("opens application settings from the gear", () => {
    renderProfile();
    fireEvent.click(screen.getByTestId("sidebar-settings-button"));
    expect(screen.getByTestId("settings-dialog")).not.toBeNull();
    expect(screen.queryByTestId("account-settings-dialog")).toBeNull();
  });
});
