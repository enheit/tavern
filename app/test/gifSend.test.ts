import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, GifAttachment } from "@tavern/shared";

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

const gif: GifAttachment = {
  url: "https://cdn.example.com/cat.gif",
  previewUrl: "https://cdn.example.com/cat-preview.gif",
  width: 320,
  height: 240,
};

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

describe("§ GIF send", () => {
  it("appends a pure-GIF row (empty body + gif)", () => {
    const store = createRoomStore("g1");
    store.getState().sendMessage("", gif);

    const { messages } = store.getState();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("");
    expect(messages[0]?.gif).toEqual(gif);
  });

  it("is a no-op for an empty body with no gif", () => {
    const store = createRoomStore("g2");
    store.getState().sendMessage("", undefined);

    expect(store.getState().messages).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("appends body text alongside the gif", () => {
    const store = createRoomStore("g3");
    store.getState().sendMessage("hey", gif);

    const { messages } = store.getState();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("hey");
    expect(messages[0]?.gif).toEqual(gif);
  });

  it("the chat.send WS frame carries the gif field", () => {
    const store = createRoomStore("g4");
    store.getState().sendMessage("", gif);

    const frame = sent.find((f) => f.t === "chat.send");
    if (frame?.t !== "chat.send") throw new Error("expected a chat.send frame");
    expect(frame.body).toBe("");
    expect(frame.gif).toEqual(gif);
  });
});
