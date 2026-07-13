import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppShell } from "@/features/shell/AppShell";
import { resetRoomStores } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { closeAllRooms } from "@/lib/wsClient";

// The tabs render TanStack Query consumers (e.g. the soundboard tab now mounts SoundboardPanel →
// useSounds), so the shell needs a QueryClientProvider; retries off so failing test-env fetches don't schedule work.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  resetRoomStores();
  useServersStore.setState({ servers: [], activeServerId: "s1", connState: {} });
});

afterEach(() => {
  cleanup();
  // SoundboardPanel opens a per-server WS via connectRoom; close it so no reconnect timer leaks.
  closeAllRooms();
  queryClient.clear();
});

describe("shell layout", () => {
  it("renders pinned grid template and named slots", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AppShell serverId="s1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell.style.gridTemplateRows).toBe("40px 1fr 64px");
    expect(shell.style.gridTemplateColumns).toBe("240px 1fr 320px");

    // Every shell region is present, with workspace navigation in the center and persistent chat on
    // the right.
    for (const id of [
      "app-header",
      "channels-panel",
      "slot-canvas",
      "slot-controls",
      "slot-chat",
    ]) {
      expect(screen.getByTestId(id)).toBeDefined();
    }
    expect(within(screen.getByTestId("slot-chat")).queryByRole("tablist")).toBeNull();
  });
});
