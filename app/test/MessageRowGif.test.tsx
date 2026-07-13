import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage, GifAttachment, Member } from "@tavern/shared";
import { MessageRow } from "@/features/chat/MessageRow";

const SELF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function member(over: Partial<Member> = {}): Member {
  return {
    userId: SELF,
    username: "alice_u",
    displayName: "Alice",
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

const gif: GifAttachment = {
  url: "https://cdn.example.com/cat.gif",
  previewUrl: "https://cdn.example.com/cat-preview.gif",
  width: 320,
  height: 240,
};

const SRV = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function renderRow(message: ChatMessage) {
  render(
    <MessageRow
      message={message}
      member={member()}
      replyMember={undefined}
      members={[member()]}
      selfUserId={SELF}
      selfUsername="alice_u"
      serverId={SRV}
      showUnreadDivider={false}
      canEdit={false}
      onReply={() => undefined}
      onEdit={() => undefined}
      onDelete={() => undefined}
      onJumpToReply={() => undefined}
      onSetReaction={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("MessageRow gif rendering", () => {
  it("renders the gif img and no body when body is empty", () => {
    renderRow(chatMessage({ id: 5, body: "", gif }));

    const img = screen.getByTestId("message-gif");
    expect(img.getAttribute("src")).toBe(gif.url);
    expect(screen.queryByTestId("message-body-5")).toBeNull();
  });

  it("renders the body text and no gif when there is no gif", () => {
    renderRow(chatMessage({ id: 6, body: "hello there" }));

    expect(screen.queryByTestId("message-gif")).toBeNull();
    expect(screen.getByTestId("message-body-6").textContent).toBe("hello there");
  });

  it("caps the gif width via an inline maxWidth of min(320px, 100%)", () => {
    renderRow(chatMessage({ id: 7, body: "", gif }));

    const img = screen.getByTestId("message-gif") as HTMLImageElement;
    expect(img.style.maxWidth).toBe("min(320px, 100%)");
  });
});
