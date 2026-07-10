import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ClientMessage, Member, ServerMessage } from "@tavern/shared";

vi.mock("@/lib/wsClient", () => ({ connectRoom: vi.fn(), closeAllRooms: vi.fn() }));

import { connectRoom } from "@/lib/wsClient";
import type { WsConnection } from "@/lib/wsClient";
import { MessageList } from "@/features/chat/MessageList";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

const SID = "s-msglist";
const SELF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// A controllable IntersectionObserver stub — jsdom has none; tests fire intersections manually.
class IOStub {
  static instances: IOStub[] = [];
  active = true;
  private observed: Element[] = [];
  constructor(private readonly cb: IntersectionObserverCallback) {
    IOStub.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.active = false;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire(isIntersecting: boolean): void {
    if (!this.active) return;
    for (const target of this.observed) {
      const entry = { isIntersecting, target } as IntersectionObserverEntry;
      this.cb([entry], this as unknown as IntersectionObserver);
    }
  }
}

function fireAllIntersections(isIntersecting: boolean): void {
  for (const io of IOStub.instances) io.fire(isIntersecting);
}

const sent: ClientMessage[] = [];
const fakeConn: WsConnection = {
  status: "open",
  send: (msg) => {
    sent.push(msg);
  },
  on: () => () => {},
  close: () => {},
};

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

function chatMessage(over: Partial<ChatMessage>): ChatMessage {
  return { id: 1, userId: SELF, body: "x", mentions: [], at: 0, ...over };
}

function seedHello(members: Member[], lastMessageId: number): void {
  const hello: Extract<ServerMessage, { t: "hello.ok" }> = {
    t: "hello.ok",
    self: member(SELF),
    serverMeta: { id: SID, nickname: "tavern", adminUserId: SELF },
    members,
    voice: { members: [], sessionStartedAt: null },
    streams: [],
    recording: { active: false },
    lastMessageId,
    costStatus: { usedGB: 0, capGB: 900, blocked: false },
  };
  roomStore(SID).getState().apply(hello);
}

beforeEach(() => {
  sent.length = 0;
  IOStub.instances = [];
  Reflect.set(globalThis, "IntersectionObserver", IOStub);
  vi.mocked(connectRoom).mockReturnValue(fakeConn);
  resetRoomStores();
  useSessionStore.getState().setAuthed({
    userId: SELF,
    username: "alice_u",
    displayName: "Alice",
    color: "#aabbcc",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FR-15 FR-17 message list", () => {
  it("self-mention gets highlight background; other mentions accent only", () => {
    seedHello([member(SELF, { username: "alice_u" }), member(BOB, { username: "bob_u" })], 0);
    act(() => {
      roomStore(SID)
        .getState()
        .apply({
          t: "chat.new",
          message: chatMessage({
            id: 3,
            userId: BOB,
            body: "hi @alice_u and @bob_u",
            mentions: [SELF, BOB],
          }),
        });
    });
    render(<MessageList serverId={SID} />);

    const mentions = screen.getAllByTestId("mention");
    const self = mentions.find((el) => el.textContent === "@alice_u");
    const other = mentions.find((el) => el.textContent === "@bob_u");
    expect(self?.getAttribute("data-self")).toBe("true");
    expect(self?.className).toContain("bg-primary/15");
    expect(other?.getAttribute("data-self")).toBe("false");
    expect(other?.className).not.toContain("bg-primary/15");
  });

  it("top sentinel triggers loadOlder while hasMore", () => {
    seedHello([member(SELF)], 5); // hasMoreHistory = true
    const loadOlder = vi.fn(() => Promise.resolve());
    roomStore(SID).setState({ loadOlder });
    render(<MessageList serverId={SID} />);

    act(() => fireAllIntersections(true));
    expect(loadOlder).toHaveBeenCalledTimes(1);

    // Once there is no more history the sentinel no longer loads.
    act(() => {
      roomStore(SID).setState({ hasMoreHistory: false });
    });
    act(() => fireAllIntersections(true));
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("scroll position preserved after prepend", () => {
    seedHello([member(SELF)], 5);
    roomStore(SID)
      .getState()
      .apply({
        t: "chat.page",
        messages: [chatMessage({ id: 20, body: "newest" })],
        hasMore: true,
      });
    roomStore(SID).setState({ loadOlder: vi.fn(() => Promise.resolve()) });
    render(<MessageList serverId={SID} />);

    const el = screen.getByTestId("message-scroll");
    let heightValue = 100;
    let topValue = 0;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => heightValue });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 0 });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => topValue,
      set: (v: number) => {
        topValue = v;
      },
    });

    // The sentinel intersects → record the pre-prepend height (100) and request older messages.
    act(() => fireAllIntersections(true));
    // The older page grows the content to 300; the delta must be added back to scrollTop.
    heightValue = 300;
    act(() => {
      roomStore(SID)
        .getState()
        .apply({
          t: "chat.page",
          messages: [chatMessage({ id: 10, body: "older" })],
          hasMore: false,
        });
    });
    expect(topValue).toBe(200);
  });

  it("pending message at reduced opacity until nonce echo", () => {
    seedHello([member(SELF, { username: "alice_u" })], 0);
    render(<MessageList serverId={SID} />);

    act(() => {
      roomStore(SID).getState().sendMessage("hello");
    });
    const pendingRow = screen.getByTestId("message--1");
    expect(pendingRow.className).toContain("opacity-60");

    const frame = sent.find((f) => f.t === "chat.send");
    if (frame?.t !== "chat.send") throw new Error("expected a chat.send frame");

    act(() => {
      roomStore(SID)
        .getState()
        .apply({
          t: "chat.new",
          message: chatMessage({ id: 9, body: "hello" }),
          nonce: frame.nonce,
        });
    });
    expect(screen.queryByTestId("message--1")).toBeNull();
    expect(screen.getByTestId("message-9").className).not.toContain("opacity-60");
  });
});
