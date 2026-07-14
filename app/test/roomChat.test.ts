import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ClientMessage } from "@tavern/shared";
import { LIMITS } from "@tavern/shared";

vi.mock("@/lib/wsClient", () => ({ connectRoom: vi.fn(), closeAllRooms: vi.fn() }));

import { connectRoom } from "@/lib/wsClient";
import type { WsConnection } from "@/lib/wsClient";
import { createRoomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

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

function chatMessage(over: Partial<ChatMessage>): ChatMessage {
  return { id: 1, userId: SELF, body: "x", mentions: [], reactions: [], at: 0, ...over };
}

beforeEach(() => {
  sent.length = 0;
  vi.mocked(connectRoom).mockReturnValue(fakeConn);
  useSessionStore.getState().setAuthed({
    userId: SELF,
    username: "alice",
    displayName: "Alice",
    color: "#aabbcc",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("FR-14 chat slice", () => {
  it("optimistic nonce lifecycle", () => {
    const store = createRoomStore("s1");

    store.getState().sendMessage("  hello world  ");
    const pending = store.getState();
    expect(pending.messages).toHaveLength(1);
    expect(pending.messages[0]?.body).toBe("hello world"); // trimmed
    expect(pending.messages[0]?.id).toBeLessThan(0); // synthetic pending id
    expect(pending.messages[0]?.userId).toBe(SELF);
    expect(pending.pendingNonces.size).toBe(1);

    const frame = sent[0];
    if (frame?.t !== "chat.send") throw new Error("expected a chat.send frame");
    expect(frame.body).toBe("hello world");
    const nonce = frame.nonce;

    // The server echo carrying the same nonce reconciles the pending row into the real message.
    store
      .getState()
      .apply({ t: "chat.new", message: chatMessage({ id: 7, body: "hello world" }), nonce });
    const echoed = store.getState();
    expect(echoed.messages).toHaveLength(1);
    expect(echoed.messages[0]?.id).toBe(7);
    expect(echoed.pendingNonces.size).toBe(0);

    // A foreign chat.new (no nonce) just appends.
    store.getState().apply({
      t: "chat.new",
      message: chatMessage({ id: 8, userId: "22222222-2222-2222-2222-222222222222", body: "hi" }),
    });
    expect(store.getState().messages).toHaveLength(2);
    expect(store.getState().messages[1]?.id).toBe(8);
  });

  it("guards empty and over-length bodies", () => {
    const store = createRoomStore("s2");
    store.getState().sendMessage("    ");
    store.getState().sendMessage("a".repeat(LIMITS.messageMaxChars + 1));
    expect(store.getState().messages).toHaveLength(0);
    expect(store.getState().pendingNonces.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("loadOlder passes the oldest message as an older cursor", async () => {
    const store = createRoomStore("s3");
    store.getState().apply({
      t: "chat.page",
      requestId: crypto.randomUUID(),
      mode: "initial",
      messages: [chatMessage({ id: 10, body: "a" }), chatMessage({ id: 11, body: "b" })],
      hasOlder: true,
      hasNewer: false,
    });

    await store.getState().loadOlder();
    const frame = sent[0];
    if (frame?.t !== "chat.history") throw new Error("expected a chat.history frame");
    expect(frame.mode).toBe("older");
    expect(frame.cursorId).toBe(10);
    expect(frame.limit).toBe(LIMITS.historyPageSize);
  });

  it("loadOlder does not request an invalid cursor when only pending rows exist", async () => {
    const store = createRoomStore("s4");
    store.getState().sendMessage("draft");
    await store.getState().loadOlder();
    expect(sent.filter((frame) => frame.t === "chat.history")).toHaveLength(0);
  });

  it("coalesces read-frontier updates while the server acknowledgement is in flight", () => {
    const store = createRoomStore("s-read");

    store.getState().markRead(10);
    store.getState().markRead(10);
    store.getState().markRead(9);
    expect(sent.filter((frame) => frame.t === "chat.read")).toEqual([
      { t: "chat.read", messageId: 10 },
    ]);

    store.getState().apply({
      t: "chat.read-state",
      lastReadMessageId: 10,
      firstUnreadMessageId: 11,
      unreadCount: 2,
    });
    store.getState().markRead(11);
    expect(sent.filter((frame) => frame.t === "chat.read")).toEqual([
      { t: "chat.read", messageId: 10 },
      { t: "chat.read", messageId: 11 },
    ]);
  });

  it("keeps a gapped unread window intact when a foreign live message arrives", () => {
    const store = createRoomStore("s5");
    store.setState({
      messages: [chatMessage({ id: 10, userId: "22222222-2222-2222-2222-222222222222" })],
      historyWindow: "around",
      hasNewerHistory: true,
      lastReadMessageId: 9,
      firstUnreadMessageId: 10,
      unreadCount: 1,
    });

    store.getState().apply({
      t: "chat.new",
      message: chatMessage({ id: 100, userId: "22222222-2222-2222-2222-222222222222" }),
    });

    expect(store.getState().messages.map((message) => message.id)).toEqual([10]);
    expect(store.getState().unreadCount).toBe(2);
  });

  it("sends replies, edits, deletes, and always advances the bottom-scroll token on own send", () => {
    const store = createRoomStore("s6");
    const source = chatMessage({
      id: 4,
      userId: "22222222-2222-2222-2222-222222222222",
      body: "source",
    });
    store.getState().setReplyingTo({
      id: source.id,
      userId: source.userId,
      body: source.body,
      deleted: false,
    });
    store.getState().sendMessage("answer");
    const send = sent.find((frame) => frame.t === "chat.send");
    expect(send).toMatchObject({ t: "chat.send", replyToId: 4, body: "answer" });
    expect(store.getState().scrollToBottomToken).toBe(1);
    expect(store.getState().replyingTo).toBeNull();

    store.getState().editMessage(9, "updated");
    store.getState().deleteMessage(9);
    expect(sent.some((frame) => frame.t === "chat.edit" && frame.messageId === 9)).toBe(true);
    expect(sent.some((frame) => frame.t === "chat.delete" && frame.messageId === 9)).toBe(true);
  });

  it("sends desired reaction state and applies authoritative reaction updates", () => {
    const store = createRoomStore("s7");
    store.setState({ messages: [chatMessage({ id: 12 })] });

    store.getState().setReaction(12, "😀", true);
    expect(sent.at(-1)).toMatchObject({
      t: "chat.reaction.set",
      messageId: 12,
      emoji: "😀",
      reacted: true,
    });

    store.getState().apply({
      t: "chat.reaction.updated",
      messageId: 12,
      emoji: "😀",
      reaction: {
        emoji: "😀",
        reactors: [{ userId: SELF, displayName: "Alice" }],
      },
    });
    expect(store.getState().messages[0]?.reactions).toEqual([
      { emoji: "😀", reactors: [{ userId: SELF, displayName: "Alice" }] },
    ]);

    store.getState().apply({
      t: "chat.reaction.updated",
      messageId: 12,
      emoji: "😀",
      reaction: null,
    });
    expect(store.getState().messages[0]?.reactions).toEqual([]);
  });
});
