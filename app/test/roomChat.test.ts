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
  return { id: 1, userId: SELF, body: "x", mentions: [], at: 0, ...over };
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

  it("loadOlder passes beforeId of oldest message", async () => {
    const store = createRoomStore("s3");
    store.getState().apply({
      t: "chat.page",
      messages: [chatMessage({ id: 10, body: "a" }), chatMessage({ id: 11, body: "b" })],
      hasMore: true,
    });

    await store.getState().loadOlder();
    const frame = sent[0];
    if (frame?.t !== "chat.history") throw new Error("expected a chat.history frame");
    expect(frame.beforeId).toBe(10); // oldest (messages[0])
    expect(frame.limit).toBe(LIMITS.historyPageSize);
  });

  it("loadOlder omits beforeId when only pending rows exist", async () => {
    const store = createRoomStore("s4");
    store.getState().sendMessage("draft");
    await store.getState().loadOlder();
    const frame = sent.find((f) => f.t === "chat.history");
    if (frame?.t !== "chat.history") throw new Error("expected a chat.history frame");
    // A pending row's synthetic negative id is not a valid wire beforeId → undefined.
    expect(frame.beforeId).toBeUndefined();
  });
});
