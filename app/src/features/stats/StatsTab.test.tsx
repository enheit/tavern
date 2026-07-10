import type { Member, StatsResponse } from "@tavern/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({
  apiClient: { get: (path: string, schema: unknown) => getMock(path, schema) },
}));

import { StatsTab } from "@/features/stats/StatsTab";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

function member(userId: string, displayName: string): Member {
  return {
    userId,
    username: displayName.toLowerCase(),
    displayName,
    color: "#4488cc",
    presence: "online",
    isAdmin: false,
    joinedAt: 0,
  };
}

let sid = "";
function seedMembers(members: Member[]): void {
  roomStore(sid).setState({ members });
}
function seedSelf(userId: string): void {
  useSessionStore.setState({
    status: "authed",
    profile: { userId, username: "self", displayName: "Self", color: "#ffffff" },
  });
}

function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <StatsTab serverId={sid} active={true} />
    </QueryClientProvider>
  );
  render(ui);
}

function rowUserIds(): string[] {
  return screen.getAllByTestId("stats-row").map((el) => el.getAttribute("data-user-id") ?? "");
}
function watchStreamerIds(): string[] {
  return screen
    .getAllByTestId("stats-watch-row")
    .map((el) => el.getAttribute("data-streamer-id") ?? "");
}

beforeEach(() => {
  getMock.mockReset();
  resetRoomStores();
  useSessionStore.setState({ status: "unauthed", profile: null });
  sid = `s-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  cleanup();
});

describe("FR-40 stats tab", () => {
  it("sorts members by messages desc", async () => {
    const stats: StatsResponse = {
      perUser: [
        { userId: "u1", messages: 3, streamSeconds: 0 },
        { userId: "u2", messages: 10, streamSeconds: 0 },
        { userId: "u3", messages: 5, streamSeconds: 0 },
      ],
      watchPairs: [],
    };
    getMock.mockResolvedValue(stats);
    seedMembers([member("u1", "Alice"), member("u2", "Bob"), member("u3", "Cara")]);
    renderTab();
    await waitFor(() => expect(rowUserIds()).toEqual(["u2", "u3", "u1"]));
  });

  it("tie-breaks by displayName asc", async () => {
    const stats: StatsResponse = {
      perUser: [
        { userId: "u1", messages: 5, streamSeconds: 0 },
        { userId: "u2", messages: 5, streamSeconds: 0 },
      ],
      watchPairs: [],
    };
    getMock.mockResolvedValue(stats);
    // Equal message counts → alphabetical by displayName: Alpha (u2) before Zeta (u1).
    seedMembers([member("u1", "Zeta"), member("u2", "Alpha")]);
    renderTab();
    await waitFor(() => expect(rowUserIds()).toEqual(["u2", "u1"]));
  });

  it("renders former member row without avatar", async () => {
    const stats: StatsResponse = {
      perUser: [{ userId: "ghost", messages: 1, streamSeconds: 120 }],
      watchPairs: [],
    };
    getMock.mockResolvedValue(stats);
    seedMembers([]); // ghost is absent from the member map → a departed member
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stats-former-member")).toBeDefined());
    expect(screen.queryByTestId("stats-avatar-img-ghost")).toBeNull();
    expect(screen.queryByTestId("stats-avatar-fallback-ghost")).toBeNull();
  });

  it("watch-most filters viewer=self, sorts desc, caps at 5", async () => {
    const stats: StatsResponse = {
      perUser: [{ userId: "me", messages: 0, streamSeconds: 0 }],
      watchPairs: [
        { viewerId: "me", streamerId: "s1", seconds: 100 },
        { viewerId: "me", streamerId: "s2", seconds: 300 },
        { viewerId: "me", streamerId: "s3", seconds: 200 },
        { viewerId: "me", streamerId: "s4", seconds: 50 },
        { viewerId: "me", streamerId: "s5", seconds: 600 },
        { viewerId: "me", streamerId: "s6", seconds: 10 },
        { viewerId: "other", streamerId: "s7", seconds: 9999 },
      ],
    };
    getMock.mockResolvedValue(stats);
    seedSelf("me");
    seedMembers([member("me", "Me")]);
    renderTab();
    // Only self's pairs, seconds DESC, capped at 5 — s6 (lowest) and the other viewer drop out.
    await waitFor(() => expect(watchStreamerIds()).toEqual(["s5", "s2", "s3", "s1", "s4"]));
    expect(screen.queryByTestId("stats-no-watch-data")).toBeNull();
  });

  it("renders noWatchData empty state", async () => {
    const stats: StatsResponse = {
      perUser: [{ userId: "me", messages: 2, streamSeconds: 0 }],
      watchPairs: [{ viewerId: "other", streamerId: "s1", seconds: 500 }],
    };
    getMock.mockResolvedValue(stats);
    seedSelf("me"); // self has watched nobody; the only pair belongs to another viewer
    seedMembers([member("me", "Me")]);
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stats-no-watch-data")).toBeDefined());
    expect(screen.queryByTestId("stats-watch-row")).toBeNull();
  });

  it("renders empty state when no members", async () => {
    const stats: StatsResponse = { perUser: [], watchPairs: [] };
    getMock.mockResolvedValue(stats);
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stats-empty")).toBeDefined());
    expect(screen.queryByTestId("stats-members-table")).toBeNull();
  });
});
