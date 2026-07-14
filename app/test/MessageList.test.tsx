import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

// ResizeObserver delivers the actual content-size change that happens after an attachment loads.
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  private observed: Element[] = [];
  constructor(private readonly cb: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {}
  fire(): void {
    this.cb(
      this.observed.map((target) => ({ target }) as ResizeObserverEntry),
      this as unknown as ResizeObserver,
    );
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
  return { id: 1, userId: SELF, body: "x", mentions: [], reactions: [], at: 0, ...over };
}

function seedHello(
  members: Member[],
  lastMessageId: number,
  unread: { first: number | null; count: number; lastRead: number } = {
    first: null,
    count: 0,
    lastRead: 0,
  },
): void {
  const hello: Extract<ServerMessage, { t: "hello.ok" }> = {
    t: "hello.ok",
    status: "",
    self: member(SELF),
    serverMeta: { id: SID, nickname: "tavern", adminUserId: SELF },
    members,
    voice: { members: [], sessionStartedAt: null },
    streams: [],
    recording: { active: false },
    lastMessageId,
    lastReadMessageId: unread.lastRead,
    firstUnreadMessageId: unread.first,
    unreadCount: unread.count,
    costStatus: { usedGB: 0, capGB: 900, blocked: false },
    polls: [],
    points: zeroPoints(),
  };
  roomStore(SID).getState().apply(hello);
}

function zeroPoints() {
  return {
    balance: 0,
    pendingPollWinnings: 0,
    currentRatePerMinute: 0,
    activeSources: [],
    today: { day: "2026-07-13", conversation: 0, streaming: 0, watching: 0, total: 0 },
    config: {
      enabled: true,
      basePointsPerMinute: 5,
      streamerBonusPerMinute: 5,
      watcherBonusPerMinute: 5,
      dailyCap: null,
    },
  };
}

beforeEach(() => {
  sent.length = 0;
  IOStub.instances = [];
  ResizeObserverStub.instances = [];
  Reflect.set(globalThis, "IntersectionObserver", IOStub);
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
  Reflect.set(Element.prototype, "scrollIntoView", () => undefined);
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

  it("top sentinel triggers loadOlder while older history exists", () => {
    seedHello([member(SELF)], 5);
    const loadOlder = vi.fn(() => Promise.resolve());
    roomStore(SID).setState({ loadOlder, hasOlderHistory: true, historyInitialized: true });
    render(<MessageList serverId={SID} />);

    act(() => fireAllIntersections(true));
    expect(loadOlder).toHaveBeenCalledTimes(1);

    // Once there is no more history the sentinel no longer loads.
    act(() => {
      roomStore(SID).setState({ hasOlderHistory: false });
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
        requestId: crypto.randomUUID(),
        mode: "initial",
        messages: [chatMessage({ id: 20, body: "newest" })],
        hasOlder: true,
        hasNewer: false,
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
    act(() => fireEvent.scroll(el));

    // The sentinel intersects → record the pre-prepend height (100) and request older messages.
    act(() => fireAllIntersections(true));
    // The older page grows the content to 300; the delta must be added back to scrollTop.
    heightValue = 300;
    act(() => {
      roomStore(SID)
        .getState()
        .apply({
          t: "chat.page",
          requestId: crypto.randomUUID(),
          mode: "older",
          messages: [chatMessage({ id: 10, body: "older" })],
          hasOlder: false,
          hasNewer: true,
        });
    });
    expect(topValue).toBe(200);
  });

  it("keeps the latest message fully visible when its content grows after render", () => {
    seedHello([member(SELF)], 1);
    roomStore(SID).setState({
      historyInitialized: true,
      messages: [chatMessage({ id: 1, body: "GIF" })],
    });
    render(<MessageList serverId={SID} />);

    const scroll = screen.getByTestId("message-scroll");
    let scrollTop = 0;
    let scrollHeight = 100;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });

    scrollHeight = 420;
    act(() => ResizeObserverStub.instances.forEach((observer) => observer.fire()));

    expect(scrollTop).toBe(420);
  });

  it("does not pull a reader back down when message content grows above the bottom", () => {
    seedHello([member(SELF)], 1);
    roomStore(SID).setState({
      historyInitialized: true,
      messages: [chatMessage({ id: 1, body: "GIF" })],
    });
    render(<MessageList serverId={SID} />);

    const scroll = screen.getByTestId("message-scroll");
    let scrollTop = 100;
    let scrollHeight = 500;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    act(() => fireEvent.scroll(scroll));

    scrollHeight = 820;
    act(() => ResizeObserverStub.instances.forEach((observer) => observer.fire()));

    expect(scrollTop).toBe(100);
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

  it("renders the durable unread divider and a new-message capsule while reading above bottom", () => {
    seedHello([member(SELF), member(BOB)], 12, { first: 11, count: 2, lastRead: 10 });
    roomStore(SID).setState({
      historyInitialized: true,
      messages: [
        chatMessage({ id: 10, userId: SELF }),
        chatMessage({ id: 11, userId: BOB }),
        chatMessage({ id: 12, userId: BOB }),
      ],
    });
    render(<MessageList serverId={SID} active={false} />);

    expect(screen.getByTestId("new-messages-divider")).toBeDefined();
    const scroll = screen.getByTestId("message-scroll");
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    act(() => fireEvent.scroll(scroll));
    expect(screen.getByTestId("new-message-capsule")).toBeDefined();
  });

  it("clicking a reply preview requests an around page when the source is not loaded", () => {
    seedHello([member(SELF), member(BOB)], 50);
    roomStore(SID).setState({
      historyInitialized: true,
      messages: [
        chatMessage({
          id: 50,
          userId: BOB,
          reply: { id: 7, userId: SELF, body: "old source", deleted: false },
        }),
      ],
    });
    render(<MessageList serverId={SID} />);
    act(() => screen.getByTestId("reply-preview-50").click());

    const request = sent.find((frame) => frame.t === "chat.history" && frame.mode === "around");
    expect(request).toMatchObject({ t: "chat.history", mode: "around", cursorId: 7 });
  });

  it("scrolls to the same replied message on every preview click", () => {
    const scrollIntoView = vi.fn();
    Reflect.set(Element.prototype, "scrollIntoView", scrollIntoView);
    seedHello([member(SELF, { displayName: "Alice", color: "#aabbcc" }), member(BOB)], 50);
    roomStore(SID).setState({
      historyInitialized: true,
      messages: [
        chatMessage({ id: 7, userId: SELF, body: "source" }),
        chatMessage({
          id: 50,
          userId: BOB,
          body: "answer",
          reply: { id: 7, userId: SELF, body: "source", deleted: false },
        }),
      ],
    });
    render(<MessageList serverId={SID} />);

    const preview = screen.getByTestId("reply-preview-50");
    act(() => preview.click());
    act(() => preview.click());

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView).toHaveBeenNthCalledWith(1, { block: "center" });
    expect(scrollIntoView).toHaveBeenNthCalledWith(2, { block: "center" });
  });

  it("renders a square full-width reply preview in the replied member color", () => {
    seedHello([member(SELF, { displayName: "Alice", color: "#aabbcc" }), member(BOB)], 50);
    roomStore(SID).setState({
      historyInitialized: true,
      messages: [
        chatMessage({
          id: 50,
          userId: BOB,
          reply: { id: 7, userId: SELF, body: "short", deleted: false },
        }),
      ],
    });
    render(<MessageList serverId={SID} />);

    const preview = screen.getByTestId("reply-preview-50");
    const author = screen.getByTestId("reply-author-50");
    expect(preview.className).toContain("w-full");
    expect(preview.className).not.toContain("rounded");
    expect(preview.style.borderLeftColor).toBe("rgb(170, 187, 204)");
    expect(author.style.color).toBe(preview.style.borderLeftColor);
  });
});
