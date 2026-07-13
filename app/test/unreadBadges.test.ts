import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSummary } from "@tavern/shared";

const { setBadge } = vi.hoisted(() => ({ setBadge: vi.fn() }));
vi.mock("@/platform/types", () => ({
  platform: { shell: { setBadge, focusWindow: vi.fn() } },
}));

import { initUnreadBadges } from "@/lib/unreadBadges";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";

function server(id: string): ServerSummary {
  return {
    id,
    nickname: id,
    adminUserId: "admin",
    hasPassword: false,
    createdAt: 1,
    joinedAt: 1,
  };
}

beforeEach(() => {
  setBadge.mockClear();
  resetRoomStores();
  useServersStore.setState({
    servers: [server("one"), server("two")],
    activeServerId: "one",
    connState: {},
  });
  document.title = "Tavern";
});

afterEach(() => {
  document.title = "Tavern";
});

describe("unread application badges", () => {
  it("aggregates every joined room and clears on teardown", () => {
    roomStore("one").setState({ unreadCount: 2 });
    roomStore("two").setState({ unreadCount: 3 });
    const stop = initUnreadBadges();

    expect(setBadge).toHaveBeenLastCalledWith(5);
    expect(document.title).toBe("(5) Tavern");
    roomStore("one").setState({ unreadCount: 0 });
    expect(setBadge).toHaveBeenLastCalledWith(3);

    stop();
    expect(setBadge).toHaveBeenLastCalledWith(null);
    expect(document.title).toBe("Tavern");
  });
});
