import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, Recording } from "@tavern/shared";

// The tab reads the list over apiClient.get and subscribes to the room's `rec.state` nudge — stub both
// seams so the suite focuses on ordering, mm:ss rendering, and delete-visibility. `vi.hoisted` lets the
// hoisted vi.mock factory reference the shared spy.
const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({
  apiClient: { get: getMock },
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/wsClient", () => ({
  connectRoom: () => ({ on: () => () => undefined, send: () => undefined }),
}));

import { RecordingsTab } from "@/features/recordings/RecordingsTab";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";

const SERVER = "22222222-2222-4222-8222-222222222222";
const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function member(userId: string, displayName: string): Member {
  return {
    userId,
    username: displayName.toLowerCase(),
    displayName,
    color: "#a1b2c3",
    presence: "online",
    isAdmin: false,
    joinedAt: 1,
  };
}

function recording(over: Partial<Recording> & { id: string; startedBy: string }): Recording {
  return { durationMs: 6000, startedAt: 1000, endedAt: 2000, ...over };
}

function seedServer(adminUserId: string): void {
  useServersStore.setState({
    servers: [
      {
        id: SERVER,
        nickname: "Cave",
        adminUserId,
        hasPassword: false,
        createdAt: 1,
        joinedAt: 1,
      },
    ],
    activeServerId: SERVER,
    connState: {},
  });
}

function renderTab(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <RecordingsTab serverId={SERVER} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
  resetRoomStores();
  getMock.mockReset();
  useSessionStore.setState({
    status: "authed",
    profile: { userId: SELF, username: "self", displayName: "Self", color: "#123456" },
  });
  roomStore(SERVER).setState({ members: [member(SELF, "Self"), member(OTHER, "Other")] });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("FR-25 recordings tab", () => {
  it("lists newest first with mm:ss from metadata", async () => {
    const older = recording({
      id: crypto.randomUUID(),
      startedBy: SELF,
      startedAt: 1000,
      durationMs: 65_000,
    });
    const newer = recording({
      id: crypto.randomUUID(),
      startedBy: OTHER,
      startedAt: 5000,
      durationMs: 6000,
    });
    getMock.mockResolvedValue({ recordings: [older, newer] }); // returned unsorted → tab sorts
    seedServer(ADMIN);

    renderTab();

    await waitFor(() => expect(screen.getByTestId("recordings-tab")).toBeDefined());
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // newest (startedAt 5000) first, then older
    expect(rows[0]?.getAttribute("data-testid")).toBe(`recording-${newer.id}`);
    expect(rows[1]?.getAttribute("data-testid")).toBe(`recording-${older.id}`);
    // mm:ss from stored durationMs metadata
    expect(screen.getByTestId(`recording-duration-${newer.id}`).textContent).toBe("0:06");
    expect(screen.getByTestId(`recording-duration-${older.id}`).textContent).toBe("1:05");
  });

  it("delete is visible only to the starter or an admin", async () => {
    const mine = recording({ id: crypto.randomUUID(), startedBy: SELF });
    const theirs = recording({ id: crypto.randomUUID(), startedBy: OTHER });
    getMock.mockResolvedValue({ recordings: [mine, theirs] });
    // Self is NOT the admin → delete only on the self-started recording.
    seedServer(ADMIN);

    renderTab();

    await waitFor(() => expect(screen.getByTestId(`recording-${mine.id}`)).toBeDefined());
    expect(screen.queryByTestId(`recording-delete-${mine.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`recording-delete-${theirs.id}`)).toBeNull();

    cleanup();
    queryClient.clear();

    // Now self IS the admin → delete visible on BOTH (including another member's recording).
    seedServer(SELF);
    getMock.mockResolvedValue({ recordings: [mine, theirs] });
    renderTab();
    await waitFor(() => expect(screen.getByTestId(`recording-${theirs.id}`)).toBeDefined());
    expect(screen.queryByTestId(`recording-delete-${theirs.id}`)).not.toBeNull();
  });
});
