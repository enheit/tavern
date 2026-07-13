import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Member } from "@tavern/shared";

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: ({
    onEmojiSelect,
    children,
  }: {
    onEmojiSelect?: (emoji: { emoji: string; label: string }) => void;
    children?: ReactNode;
  }) => (
    <div data-testid="mock-reaction-picker">
      <button
        type="button"
        data-testid="mock-reaction-emoji"
        onClick={() => onEmojiSelect?.({ emoji: "😄", label: "smile" })}
      >
        😄
      </button>
      {children}
    </div>
  ),
  EmojiPickerSearch: () => null,
  EmojiPickerContent: () => null,
  EmojiPickerFooter: () => null,
}));

import { MessageRow } from "@/features/chat/MessageRow";

const SELF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function member(userId: string, displayName: string): Member {
  return {
    userId,
    username: displayName.toLowerCase(),
    displayName,
    color: "#8b5cf6",
    presence: "online",
    isAdmin: false,
    joinedAt: 1,
  };
}

function renderRow(message: ChatMessage, onSetReaction = vi.fn()) {
  const members = [member(SELF, "Alice"), member(OTHER, "Bob")];
  render(
    <MessageRow
      message={message}
      member={members[1]}
      replyMember={undefined}
      members={members}
      selfUserId={SELF}
      selfUsername="alice"
      serverId="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      showUnreadDivider={false}
      canEdit={false}
      onReply={() => undefined}
      onEdit={() => undefined}
      onDelete={() => undefined}
      onJumpToReply={() => undefined}
      onSetReaction={onSetReaction}
    />,
  );
  return onSetReaction;
}

afterEach(() => cleanup());

describe("MessageRow reactions", () => {
  it("renders a selected capsule and clicking it removes only the current user's reaction", () => {
    const onSetReaction = renderRow(
      {
        id: 7,
        userId: OTHER,
        body: "hello",
        mentions: [],
        reactions: [
          {
            emoji: "😀",
            reactors: [
              { userId: SELF, displayName: "Old Alice" },
              { userId: OTHER, displayName: "Old Bob" },
            ],
          },
        ],
        at: 1,
      },
      vi.fn(),
    );

    const capsule = screen.getByTestId("reaction-7-😀");
    expect(capsule.getAttribute("aria-pressed")).toBe("true");
    expect(capsule.textContent).toBe("😀2");
    fireEvent.click(capsule);
    expect(onSetReaction).toHaveBeenCalledWith("😀", false);
  });

  it("opens the picker, adds the selected emoji, and closes after the pick", async () => {
    const onSetReaction = renderRow({
      id: 8,
      userId: OTHER,
      body: "hello",
      mentions: [],
      reactions: [],
      at: 1,
    });

    fireEvent.click(screen.getByTestId("add-reaction-8"));
    fireEvent.click(await screen.findByTestId("mock-reaction-emoji"));

    expect(onSetReaction).toHaveBeenCalledWith("😄", true);
    expect(screen.queryByTestId("mock-reaction-picker")).toBeNull();
  });

  it("summarizes long reactor name lists after eight people", async () => {
    const reactors = Array.from({ length: 9 }, (_, index) => ({
      userId: crypto.randomUUID(),
      displayName: `Person ${index + 1}`,
    }));
    renderRow({
      id: 9,
      userId: OTHER,
      body: "hello",
      mentions: [],
      reactions: [{ emoji: "🎉", reactors }],
      at: 1,
    });

    fireEvent.mouseEnter(screen.getByTestId("reaction-9-🎉"));
    expect(await screen.findByText(/8, and 1 others/)).toBeDefined();
    expect(screen.queryByText("Person 9")).toBeNull();
  });
});
