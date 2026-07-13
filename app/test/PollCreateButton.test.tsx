import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@tavern/shared";
import { PollCreateButton } from "@/features/polls/PollCreateButton";
import { resetRoomStores } from "@/stores/room";
import { connectRoom } from "@/lib/wsClient";

vi.mock("@/lib/wsClient", () => ({ connectRoom: vi.fn(), closeAllRooms: vi.fn() }));

const sent: ClientMessage[] = [];
beforeEach(() => {
  sent.length = 0;
  resetRoomStores();
  vi.mocked(connectRoom).mockReturnValue({
    status: "open",
    send: (message) => sent.push(message),
    on: () => () => {},
    close: () => {},
  });
});
afterEach(() => cleanup());

describe("poll creation", () => {
  it("validates and sends a two-outcome timed poll", () => {
    render(<PollCreateButton serverId="poll-room" />);
    fireEvent.click(screen.getByTestId("composer-poll"));
    fireEvent.change(screen.getByTestId("poll-question"), { target: { value: "Who wins?" } });
    fireEvent.change(screen.getByTestId("poll-outcome-0"), { target: { value: "Blue" } });
    fireEvent.change(screen.getByTestId("poll-outcome-1"), { target: { value: "Red" } });
    fireEvent.change(screen.getByTestId("poll-duration"), { target: { value: "300" } });
    fireEvent.click(screen.getByTestId("poll-create-submit"));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      t: "poll.create",
      question: "Who wins?",
      outcomes: ["Blue", "Red"],
      durationSeconds: 300,
    });
  });
});
