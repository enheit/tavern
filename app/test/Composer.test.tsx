import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ClientMessage, Member } from "@tavern/shared";

vi.mock("@/lib/wsClient", () => ({ connectRoom: vi.fn(), closeAllRooms: vi.fn() }));

// frimousse fetches emoji data from a URL (jsdom cannot); stub the picker so the popover renders a
// single deterministic "pick" button that fires onEmojiSelect — this exercises Composer's insertion.
vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: ({
    onEmojiSelect,
    children,
  }: {
    onEmojiSelect?: (emoji: { emoji: string; label: string }) => void;
    children?: ReactNode;
  }) => (
    <div>
      <button
        type="button"
        data-testid="mock-emoji"
        onClick={() => onEmojiSelect?.({ emoji: "😀", label: "grinning" })}
      >
        pick
      </button>
      {children}
    </div>
  ),
  EmojiPickerSearch: () => null,
  EmojiPickerContent: () => null,
  EmojiPickerFooter: () => null,
}));

import { connectRoom } from "@/lib/wsClient";
import type { WsConnection } from "@/lib/wsClient";
import { Composer } from "@/features/chat/Composer";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

const SID = "s-composer";
const SELF = "11111111-1111-1111-1111-111111111111";
const sent: ClientMessage[] = [];
const fakeConn: WsConnection = {
  status: "open",
  send: (msg) => {
    sent.push(msg);
  },
  on: () => () => {},
  close: () => {},
};

function member(userId: string, username: string): Member {
  return {
    userId,
    username,
    displayName: username,
    color: "#8b5cf6",
    presence: "online",
    isAdmin: false,
    joinedAt: 1,
  };
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
  Reflect.set(Element.prototype, "scrollIntoView", () => undefined);
});

beforeEach(() => {
  sent.length = 0;
  vi.mocked(connectRoom).mockReturnValue(fakeConn);
  resetRoomStores();
  roomStore(SID).setState({
    members: [member(SELF, "bob_u"), member("22222222-2222-2222-2222-222222222222", "bella_u")],
    historyInitialized: true,
  });
  useSessionStore.getState().setAuthed({
    userId: SELF,
    username: "bob_u",
    displayName: "Bob",
    color: "#8b5cf6",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function chatSends(): ClientMessage[] {
  return sent.filter((f) => f.t === "chat.send");
}

describe("FR-14 composer", () => {
  it("places the compact points control directly beside GIF", () => {
    render(<Composer serverId={SID} />);
    const gif = screen.getByTestId("composer-gif");
    const points = screen.getByTestId("points-trigger");

    expect(gif.parentElement).toBe(points.parentElement);
    expect(gif.nextElementSibling).toBe(points);
    expect(points.textContent).toBe("0");
  });

  it("Enter sends trimmed body and clears", () => {
    render(<Composer serverId={SID} />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("composer-input");
    fireEvent.change(ta, { target: { value: "  hello world  ", selectionStart: 15 } });
    fireEvent.keyDown(ta, { key: "Enter" });

    const frames = chatSends();
    expect(frames).toHaveLength(1);
    if (frames[0]?.t !== "chat.send") throw new Error("expected chat.send");
    expect(frames[0].body).toBe("hello world"); // trimmed by the store
    expect(ta.value).toBe("");
  });

  it("Shift+Enter inserts newline without sending", () => {
    render(<Composer serverId={SID} />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("composer-input");
    fireEvent.change(ta, { target: { value: "line one", selectionStart: 8 } });
    // Shift+Enter is not prevented → the browser inserts a newline; crucially it must NOT send.
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });

    expect(chatSends()).toHaveLength(0);
    expect(ta.value).toBe("line one");
  });

  it("blocks >2000 chars and shows counter from 1801", () => {
    render(<Composer serverId={SID} />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("composer-input");

    fireEvent.change(ta, { target: { value: "a".repeat(1800), selectionStart: 1800 } });
    expect(screen.queryByTestId("composer-counter")).toBeNull();

    fireEvent.change(ta, { target: { value: "a".repeat(1801), selectionStart: 1801 } });
    expect(screen.getByTestId("composer-counter").textContent).toBe("1801 / 2000");

    fireEvent.change(ta, { target: { value: "a".repeat(2001), selectionStart: 2001 } });
    expect(screen.getByTestId("composer-counter").textContent).toBe("2001 / 2000");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(chatSends()).toHaveLength(0); // over the limit → blocked
    expect(screen.getByTestId<HTMLButtonElement>("composer-send").disabled).toBe(true);
  });

  it("renders the emoji trigger inside the input and inserts a pick at the caret", async () => {
    render(<Composer serverId={SID} />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("composer-input");
    const emojiTrigger = screen.getByTestId("composer-emoji");
    expect(screen.getByTestId("composer-input-shell").contains(emojiTrigger)).toBe(true);
    fireEvent.change(ta, { target: { value: "ab", selectionStart: 2 } });
    ta.setSelectionRange(1, 1); // caret between a and b

    fireEvent.click(emojiTrigger);
    const pick = await screen.findByTestId("mock-emoji");
    fireEvent.click(pick);

    expect(ta.value).toBe("a😀b");
    expect(document.activeElement).toBe(ta);
  });

  it("mention pick inserts @username with trailing space (FR-15)", () => {
    render(<Composer serverId={SID} />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("composer-input");
    fireEvent.change(ta, { target: { value: "hi @bob", selectionStart: 7 } });

    expect(screen.getByTestId("mention-autocomplete")).toBeDefined();
    fireEvent.mouseDown(screen.getByTestId("mention-option-bob_u"));

    expect(ta.value).toBe("hi @bob_u ");
  });

  it("Enter selects mention instead of sending while autocomplete open", () => {
    render(<Composer serverId={SID} />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("composer-input");
    fireEvent.change(ta, { target: { value: "hi @bob", selectionStart: 7 } });
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(chatSends()).toHaveLength(0);
    expect(ta.value).toBe("hi @bob_u ");
  });

  it("ArrowUp in an empty composer edits the latest own message", () => {
    const messages: ChatMessage[] = [
      { id: 1, userId: SELF, body: "first", mentions: [], reactions: [], at: 1 },
      { id: 2, userId: SELF, body: "latest", mentions: [], reactions: [], at: 2 },
    ];
    roomStore(SID).setState({ messages });
    render(<Composer serverId={SID} />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("composer-input");

    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("latest");
    expect(
      screen.getByTestId("composer-input-shell").contains(screen.getByTestId("composer-edit")),
    ).toBe(true);
    fireEvent.change(ta, { target: { value: "latest edited", selectionStart: 13 } });
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(sent.some((frame) => frame.t === "chat.edit" && frame.messageId === 2)).toBe(true);
  });

  it("shows and clears the reply context", () => {
    roomStore(SID).getState().setReplyingTo({
      id: 7,
      userId: "22222222-2222-2222-2222-222222222222",
      body: "source",
      deleted: false,
    });
    render(<Composer serverId={SID} />);
    expect(
      screen.getByTestId("composer-input-shell").contains(screen.getByTestId("composer-reply")),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("composer-cancel-reply"));
    expect(screen.queryByTestId("composer-reply")).toBeNull();
  });

  it("renders reply and ArrowUp edit attachment thumbnails inside the input shell", () => {
    roomStore(SID).setState({
      messages: [
        {
          id: 8,
          userId: SELF,
          body: "",
          mentions: [],
          reactions: [],
          at: 1,
          image: {
            id: "33333333-3333-4333-8333-333333333333",
            width: 320,
            height: 180,
          },
        },
      ],
    });
    roomStore(SID)
      .getState()
      .setReplyingTo({
        id: 7,
        userId: "22222222-2222-2222-2222-222222222222",
        body: "",
        deleted: false,
        gif: {
          url: "https://example.com/full.gif",
          previewUrl: "https://example.com/preview.gif",
          width: 320,
          height: 180,
        },
      });
    render(<Composer serverId={SID} />);

    const shell = screen.getByTestId("composer-input-shell");
    const thumbnail = screen.getByTestId<HTMLImageElement>("composer-context-thumbnail");
    expect(shell.contains(thumbnail)).toBe(true);
    expect(thumbnail.src).toBe("https://example.com/preview.gif");

    fireEvent.click(screen.getByTestId("composer-cancel-reply"));
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "ArrowUp" });
    const editThumbnail = screen.getByTestId<HTMLImageElement>("composer-context-thumbnail");
    expect(shell.contains(editThumbnail)).toBe(true);
    expect(editThumbnail.getAttribute("src")).toBe(
      "/api/chat-images/s-composer/33333333-3333-4333-8333-333333333333.webp",
    );
  });

  it("Escape cancels reply and edit modes", () => {
    const messages: ChatMessage[] = [
      { id: 1, userId: SELF, body: "latest", mentions: [], reactions: [], at: 1 },
    ];
    roomStore(SID).setState({ messages });
    const { rerender } = render(<Composer serverId={SID} />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("composer-input");

    roomStore(SID).getState().setReplyingTo({
      id: 7,
      userId: "22222222-2222-2222-2222-222222222222",
      body: "source",
      deleted: false,
    });
    rerender(<Composer serverId={SID} />);
    expect(document.activeElement).toBe(ta);
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByTestId("composer-reply")).toBeNull();

    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(screen.getByTestId("composer-edit")).toBeDefined();
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByTestId("composer-edit")).toBeNull();
    expect(ta.value).toBe("");
  });
});
