import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSummary } from "@tavern/shared";

// sonner's toast is the only external seam ServerPage's kicked handler drives.
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { m } from "@/paraglide/messages.js";
import { toast } from "sonner";
import { ServerPage } from "@/features/servers/ServerPage";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";

const SID = "11111111-1111-4111-8111-111111111111";

function summary(over: Partial<ServerSummary> = {}): ServerSummary {
  return {
    id: SID,
    nickname: "Cave",
    adminUserId: crypto.randomUUID(),
    hasPassword: false,
    createdAt: 1,
    joinedAt: 1,
    ...over,
  };
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/s/:serverId" element={<ServerPage />} />
        <Route path="/join" element={<div data-testid="join-marker" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetRoomStores();
  useServersStore.setState({ servers: [], activeServerId: null, connState: {} });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("FR-11 kicked handling", () => {
  it("kicked event shows toast, removes server, navigates /join when active", async () => {
    useServersStore.setState({ servers: [summary()], activeServerId: SID });
    roomStore(SID).getState().apply({ t: "kicked", at: 1 });

    renderAt(`/s/${SID}`);

    await screen.findByTestId("join-marker");
    expect(toast).toHaveBeenCalledWith(m.servers_kicked_toast({ server: "Cave" }));
    expect(useServersStore.getState().servers).toHaveLength(0);
    expect(useServersStore.getState().activeServerId).toBeNull();
  });

  it("unknown serverId redirects /join", async () => {
    renderAt("/s/22222222-2222-4222-8222-222222222222");

    await screen.findByTestId("join-marker");
    expect(toast).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("app-shell")).toBeNull());
  });
});
