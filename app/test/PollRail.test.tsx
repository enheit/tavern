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
  it("stays visible and lets members switch between running polls", () => {
    const first = poll("33333333-3333-4333-8333-333333333333", "First question");
    const second = poll("44444444-4444-4444-8444-444444444444", "Second question");
    roomStore("rail-room").setState({ polls: [first, second] });
    render(<PollRail serverId="rail-room" />);

    const rail = screen.getByTestId("poll-rail");
    expect(rail.querySelectorAll("article")).toHaveLength(1);
    expect(rail.classList.contains("justify-center")).toBe(true);
    expect(screen.getByText("First question")).toBeDefined();
    expect(screen.getByText("Closes in 1m")).toBeDefined();
    expect(screen.getByTestId("poll-time-progress")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Next poll" }));
    expect(screen.getByText("Second question")).toBeDefined();
  });

  it("reveals inline bid controls after selecting an outcome", () => {
    const activePoll = poll("33333333-3333-4333-8333-333333333333", "First question");
    roomStore("rail-room").setState({
      polls: [activePoll],
      points: {
        ...roomStore("rail-room").getState().points,
        balance: 10,
      },
    });
    render(<PollRail serverId="rail-room" />);

    fireEvent.click(screen.getByTestId(`poll-choice-${activePoll.outcomes[1]?.id}`));
    expect(
      screen.getByTestId(`poll-choice-${activePoll.outcomes[1]?.id}`).getAttribute("aria-checked"),
    ).toBe("true");

    const amount = screen.getByTestId<HTMLInputElement>("poll-bid-amount");
    expect(document.activeElement).toBe(amount);
    fireEvent.change(amount, { target: { value: "" } });
    expect(amount.value).toBe("");
    expect((screen.getByTestId("poll-bid-submit") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(amount, { target: { value: "10" } });
    expect(amount.value).toBe("10");
  });

  it("shows poll settings only to the creator", () => {
    const activePoll = poll("33333333-3333-4333-8333-333333333333", "First question");
    roomStore("rail-room").setState({ polls: [activePoll] });
    useSessionStore.getState().setAuthed({
      userId: CREATOR,
      username: "creator",
      displayName: "Creator",
      color: "#8b5cf6",
    });
    render(<PollRail serverId="rail-room" />);

    expect(screen.getByTestId(`poll-settings-${activePoll.id}`)).toBeDefined();
  });

  it("shows vote totals without radio controls after the poll closes", () => {
    const expiredPoll = {
      ...poll("33333333-3333-4333-8333-333333333333", "First question"),
      closesAt: Date.now() - 1,
    };
    roomStore("rail-room").setState({ polls: [expiredPoll] });
    render(<PollRail serverId="rail-room" />);

    expect(screen.queryByTestId(`poll-choice-${expiredPoll.outcomes[0]?.id}`)).toBeNull();
    expect(screen.getByText("Blue")).toBeDefined();
    expect(screen.getByText("Red")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "1" })).toHaveLength(2);
  });

  it("shows a result countdown and a clear winning outcome", () => {
    const now = Date.now();
    const base = poll("33333333-3333-4333-8333-333333333333", "First question");
    const resolvedPoll = {
      ...base,
      status: "resolved_pending" as const,
      resolvedAt: now,
      resultVisibleUntil: now + 8_000,
      winningOutcomeId: base.outcomes[1]?.id ?? null,
      myBid: {
        outcomeId: base.outcomes[1]?.id ?? "",
        stake: 200,
        payout: 1223,
        placedAt: now - 1_000,
      },
    };
    roomStore("rail-room").setState({ polls: [resolvedPoll] });
    render(<PollRail serverId="rail-room" />);

    expect(screen.getByText("You won 1023 points")).toBeDefined();
    expect(screen.getByText("Closing in 8s")).toBeDefined();
    expect(screen.getByTestId("poll-time-progress")).toBeDefined();
    expect(screen.getByTestId(`poll-card-${resolvedPoll.id}`).className).toContain(
      "border-emerald-500/60",
    );
  });

  it("uses hours and minutes for the resolution deadline", () => {
    const lockedPoll = {
      ...poll("33333333-3333-4333-8333-333333333333", "First question"),
      status: "locked" as const,
      lockedAt: Date.now() - 5 * 60_000,
    };
    roomStore("rail-room").setState({ polls: [lockedPoll] });
    render(<PollRail serverId="rail-room" />);

    expect(screen.getByText("Resolve within 23h 55m")).toBeDefined();
  });
});
