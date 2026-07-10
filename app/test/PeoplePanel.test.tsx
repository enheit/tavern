import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Member, Presence, ServerMessage } from "@tavern/shared";
import { PeoplePanel } from "@/features/servers/PeoplePanel";
import { resetRoomStores, roomStore } from "@/stores/room";

const SID = "s-people";

function member(userId: string, over: Partial<Member> = {}): Member {
  return {
    userId,
    username: "handle",
    displayName: "Member",
    color: "#8b5cf6",
    presence: "online",
    isAdmin: false,
    joinedAt: 1,
    ...over,
  };
}

function seed(members: Member[]): void {
  const hello: Extract<ServerMessage, { t: "hello.ok" }> = {
    t: "hello.ok",
    self: member(members[0]?.userId ?? "self"),
    serverMeta: { id: SID, nickname: "cave", adminUserId: members[0]?.userId ?? "self" },
    members,
    voice: { members: [], sessionStartedAt: null },
    streams: [],
    recording: { active: false },
    lastMessageId: 0,
    costStatus: { usedGB: 0, capGB: 900, blocked: false },
  };
  roomStore(SID).getState().apply(hello);
}

beforeEach(() => {
  resetRoomStores();
});

afterEach(() => {
  cleanup();
});

describe("FR-45 people panel", () => {
  it("sorts admin first, then presence rank, then name", () => {
    seed([
      member("u1", { isAdmin: true, presence: "online", displayName: "Bob" }),
      member("u2", { isAdmin: true, presence: "online", displayName: "Alice" }),
      member("u3", { isAdmin: false, presence: "in-voice", displayName: "Yan" }),
      member("u4", { isAdmin: false, presence: "online", displayName: "Xena" }),
      member("u5", { isAdmin: false, presence: "offline", displayName: "Amy" }),
    ]);
    render(<PeoplePanel serverId={SID} />);

    const names = screen.getAllByTestId(/^member-name-/).map((el) => el.textContent);
    // Admins first (Alice < Bob by name), then non-admins by presence rank in-voice→online→offline.
    expect(names).toEqual(["Alice", "Bob", "Yan", "Xena", "Amy"]);
  });

  it("renders pinned dot color class per presence state", () => {
    const cases: [string, Presence, string][] = [
      ["a", "offline", "bg-gray-400"],
      ["b", "online", "bg-green-500"],
      ["c", "in-voice", "bg-violet-500"],
    ];
    seed(cases.map(([id, presence]) => member(id, { presence, displayName: id })));
    render(<PeoplePanel serverId={SID} />);

    for (const [id, , cls] of cases) {
      expect(screen.getByTestId(`presence-${id}`).classList).toContain(cls);
    }
  });

  it("renders displayName in member color", () => {
    seed([member("u1", { displayName: "Violet", color: "#8b5cf6" })]);
    render(<PeoplePanel serverId={SID} />);

    const name = screen.getByTestId("member-name-u1");
    expect(name.textContent).toBe("Violet");
    // jsdom serializes the inline color to rgb; accept either form.
    expect(["#8b5cf6", "rgb(139, 92, 246)"]).toContain(name.style.color);
  });

  it("falls back to initial block when avatar 404s", () => {
    seed([member("u1", { displayName: "Zed", color: "#8b5cf6" })]);
    render(<PeoplePanel serverId={SID} />);

    const img = screen.getByTestId("avatar-img-u1");
    expect(screen.queryByTestId("avatar-fallback-u1")).toBeNull();
    fireEvent.error(img);

    const fallback = screen.getByTestId("avatar-fallback-u1");
    expect(fallback.textContent).toBe("Z");
    expect(screen.queryByTestId("avatar-img-u1")).toBeNull();
    expect(["#8b5cf6", "rgb(139, 92, 246)"]).toContain(fallback.style.backgroundColor);
  });
});
