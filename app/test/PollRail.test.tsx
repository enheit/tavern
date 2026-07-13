import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Poll } from "@tavern/shared";
import { PollRail } from "@/features/polls/PollRail";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

const SELF = "11111111-1111-4111-8111-111111111111";
const CREATOR = "22222222-2222-4222-8222-222222222222";

function poll(id: string, question: string): Poll {
  return {
    id,
    creatorId: CREATOR,
    creatorDisplayName: "Creator",
    question,
    outcomes: [
      { id: crypto.randomUUID(), title: "Blue", totalPoints: 10, bidderCount: 1 },
      { id: crypto.randomUUID(), title: "Red", totalPoints: 20, bidderCount: 1 },
    ],
    status: "open",
    createdAt: Date.now(),
    closesAt: Date.now() + 60_000,
    lockedAt: null,
    resolvedAt: null,
    finalizesAt: null,
    finalizedAt: null,
    voidedAt: null,
    winningOutcomeId: null,
    correctionUsed: false,
    resultVisibleUntil: null,
    totalPool: 30,
    myBid: null,
  };
}

beforeEach(() => {
  resetRoomStores();
  useSessionStore
    .getState()
    .setAuthed({ userId: SELF, username: "self_user", displayName: "Self", color: "#8b5cf6" });
});
afterEach(() => cleanup());

describe("active poll rail", () => {
  it("starts open, centers the rail, and can collapse into a chip", () => {
    const first = poll("33333333-3333-4333-8333-333333333333", "First question");
    const second = poll("44444444-4444-4444-8444-444444444444", "Second question");
    roomStore("rail-room").setState({ polls: [first, second] });
    render(<PollRail serverId="rail-room" />);

    const rail = screen.getByTestId("poll-rail");
    expect(rail.querySelectorAll("article")).toHaveLength(1);
    expect(rail.classList.contains("justify-center")).toBe(true);
    expect(screen.getByText("First question")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Collapse poll details/i }));
    expect(rail.querySelectorAll("article")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /2 running polls/i })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /2 running polls/i }));
    expect(rail.querySelectorAll("article")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next poll" }));
    expect(screen.getByText("Second question")).toBeDefined();
  });
});
