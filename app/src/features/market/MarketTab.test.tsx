import type { MarketItem, PointSnapshot } from "@tavern/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("@/lib/apiClient", () => ({
  ApiError: class ApiError extends Error {},
  apiClient: api,
}));
vi.mock("@/lib/wsClient", () => ({
  connectRoom: () => ({ on: () => () => undefined }),
}));

import { MarketTab } from "./MarketTab";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

const SERVER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ITEM_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const points: PointSnapshot = {
  balance: 100,
  pendingPollWinnings: 0,
  currentRatePerMinute: 0,
  activeSources: [],
  today: { day: "2026-07-14", conversation: 0, streaming: 0, watching: 0, total: 0 },
  config: {
    enabled: true,
    basePointsPerMinute: 5,
    streamerBonusPerMinute: 5,
    watcherBonusPerMinute: 5,
    dailyCap: null,
  },
};
const item: MarketItem = {
  id: ITEM_ID,
  kind: "icon",
  name: "Fox",
  price: 40,
  revision: 2,
  createdBy: USER_ID,
  createdAt: 1,
  updatedAt: 2,
  purchase: null,
};

function renderMarket(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MarketTab serverId={SERVER_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetRoomStores();
  useSessionStore.setState({
    status: "authed",
    profile: { userId: USER_ID, username: "alice", displayName: "Alice", color: "#8b5cf6" },
  });
  roomStore(SERVER_ID).setState({
    serverMeta: { id: SERVER_ID, nickname: "Friends", adminUserId: USER_ID },
    points,
    members: [
      {
        userId: USER_ID,
        username: "alice",
        displayName: "Alice",
        color: "#8b5cf6",
        presence: "online",
        isAdmin: true,
        joinedAt: 1,
      },
    ],
  });
  api.get.mockReset().mockResolvedValue({ items: [item], nextCursor: null });
  api.post.mockReset().mockResolvedValue({
    item: {
      ...item,
      purchase: { buyerId: USER_ID, buyerDisplayName: "Alice", pricePaid: 40, purchasedAt: 3 },
    },
    points: { ...points, balance: 60 },
    equippedIcon: { itemId: ITEM_ID, name: "Fox", pricePaid: 40, purchasedAt: 3 },
  });
  api.patch.mockReset();
  api.put.mockReset();
  api.del.mockReset();
  api.upload.mockReset();
});

afterEach(() => cleanup());

describe("market tab", () => {
  it("requires purchase confirmation and forwards the wear-immediately choice with the revision", async () => {
    renderMarket();
    fireEvent.click(await screen.findByRole("button", { name: "Purchase" }));
    expect(screen.getByRole("heading", { name: "Purchase Fox?" })).not.toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Purchase" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/api/servers/${SERVER_ID}/market/${ITEM_ID}/purchase`,
        expect.anything(),
        { expectedRevision: 2, wearImmediately: true },
      ),
    );
  });

  it("shows the admin-only management subtab and complete upload formats", async () => {
    renderMarket();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    const input = document.querySelector('input[type="file"]');
    expect(input?.getAttribute("accept")).toBe("image/png,image/jpeg,image/gif,image/webp");
    expect(screen.getByText("Nickname preview")).not.toBeNull();
  });
});
