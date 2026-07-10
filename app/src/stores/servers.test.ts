import type { ServerMessage, ServerSummary } from "@tavern/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";

function summary(over: Partial<ServerSummary> = {}): ServerSummary {
  return {
    id: "s1",
    nickname: "old-name",
    adminUserId: "u1",
    hasPassword: false,
    createdAt: 1,
    joinedAt: 1,
    ...over,
  };
}

// Seed a room store with a hello.ok so its serverMeta.nickname exists for applyServerUpdated to patch.
function seedRoom(serverId: string, nickname: string): void {
  const hello: Extract<ServerMessage, { t: "hello.ok" }> = {
    t: "hello.ok",
    self: { userId: "u1", username: "admin", displayName: "Admin", color: "#ffffff" },
    serverMeta: { id: serverId, nickname, adminUserId: "u1" },
    members: [],
    voice: { members: [], sessionStartedAt: null },
    streams: [],
    recording: { active: false },
    lastMessageId: null,
    costStatus: { usedGB: 0, capGB: 900, blocked: false },
  };
  roomStore(serverId).getState().apply(hello);
}

beforeEach(() => {
  resetRoomStores();
  useServersStore.setState({ servers: [], activeServerId: null, connState: {} });
});

describe("FR-12 rename propagation", () => {
  it("applyServerUpdated updates dropdown list and active serverMeta", () => {
    seedRoom("s1", "old-name");
    useServersStore.setState({
      servers: [
        summary({ id: "s1", nickname: "old-name" }),
        summary({ id: "s2", nickname: "other" }),
      ],
      activeServerId: "s1",
    });

    useServersStore.getState().applyServerUpdated("s1", "new-name");

    // Header dropdown list: the matching server's nickname changes; siblings are untouched.
    const servers = useServersStore.getState().servers;
    expect(servers.find((s) => s.id === "s1")?.nickname).toBe("new-name");
    expect(servers.find((s) => s.id === "s2")?.nickname).toBe("other");
    // The active room's serverMeta reflects the new name too (FR-12 AC: members see it live).
    expect(roomStore("s1").getState().serverMeta?.nickname).toBe("new-name");
  });
});
