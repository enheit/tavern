import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, Member } from "@tavern/shared";

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

const SID = "s-composer";
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
    members: [
      member("11111111-1111-1111-1111-111111111111", "bob_u"),
      member("22222222-2222-2222-2222-222222222222", "bella_u"),
    ],
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

  // Emoji button temporarily hidden in Composer (SHOW_EMOJI=false); re-enable this when it returns.
  it.skip("emoji pick inserts at caret and refocuses", async () => {
    render(<Composer serverId={SID} />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("composer-input");
    fireEvent.change(ta, { target: { value: "ab", selectionStart: 2 } });
    ta.setSelectionRange(1, 1); // caret between a and b

    fireEvent.click(screen.getByTestId("composer-emoji"));
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
});
