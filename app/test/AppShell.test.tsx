import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppShell } from "@/features/shell/AppShell";
import { resetRoomStores } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { closeAllRooms } from "@/lib/wsClient";
import { useMediaStore } from "@/stores/media";

// The tabs render TanStack Query consumers (e.g. the soundboard tab now mounts SoundboardPanel →
// useSounds), so the shell needs a QueryClientProvider; retries off so failing test-env fetches don't schedule work.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  resetRoomStores();
  useServersStore.setState({ servers: [], activeServerId: "s1", connState: {} });
  useMediaStore.setState({ voiceStatus: "idle", inVoiceServerId: null });
  useSessionStore.setState({
    status: "authed",
    avatarRevision: 0,
    profile: {
      userId: "00000000-0000-4000-8000-000000000001",
      username: "alice",
      displayName: "Alice",
      color: "#aabbcc",
    },
  });
});

afterEach(() => {
  cleanup();
  // SoundboardPanel opens a per-server WS via connectRoom; close it so no reconnect timer leaks.
  closeAllRooms();
  queryClient.clear();
});

describe("shell layout", () => {
  it("gives the workspace the full height and removes the controls section outside voice", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AppShell serverId="s1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell.style.gridTemplateRows).toBe("40px 1fr");
    expect(shell.style.gridTemplateColumns).toBe("240px 1fr 320px");

    // Every shell region is present, with workspace navigation in the center and persistent chat on
    // the right.
    for (const id of [
      "app-header",
      "channels-panel",
      "sidebar-profile",
      "slot-canvas",
      "slot-chat",
    ]) {
      expect(screen.getByTestId(id)).toBeDefined();
    }
    expect(screen.queryByTestId("slot-controls")).toBeNull();
    expect(screen.queryByTestId("user-menu")).toBeNull();
    expect(within(screen.getByTestId("slot-chat")).queryByRole("tablist")).toBeNull();
  });

  it("adds the controls row only while joined to voice on the displayed server", () => {
    useMediaStore.setState({ voiceStatus: "joined", inVoiceServerId: "s1" });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AppShell serverId="s1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("app-shell").style.gridTemplateRows).toBe("40px 1fr 64px");
    expect(screen.getByTestId("slot-controls")).toBeDefined();
  });
});
