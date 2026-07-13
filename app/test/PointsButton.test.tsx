import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PointsButton } from "@/features/chat/PointsButton";
import { resetRoomStores, roomStore } from "@/stores/room";

const SID = "points-room";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
});

beforeEach(() => resetRoomStores());
afterEach(() => cleanup());

describe("points button", () => {
  it("renders only the coin and balance in its collapsed state", () => {
    render(<PointsButton serverId={SID} />);

    expect(screen.getByTestId("points-trigger").textContent).toBe("0");
    expect(screen.getByTestId("points-balance").textContent).toBe("0");
  });

  it("keeps earning details inside the popover", async () => {
    roomStore(SID).setState({
      points: {
        balance: 2_580,
        pendingPollWinnings: 120,
        currentRatePerMinute: 15,
        activeSources: ["conversation", "streaming", "watching"],
        today: {
          day: "2026-07-13",
          conversation: 20,
          streaming: 10,
          watching: 5,
          total: 35,
        },
        config: {
          enabled: true,
          basePointsPerMinute: 5,
          streamerBonusPerMinute: 5,
          watcherBonusPerMinute: 5,
          dailyCap: null,
        },
      },
    });

    render(<PointsButton serverId={SID} />);
    expect(screen.getByTestId("points-trigger").textContent).toMatch(/2[,.\s]?580/);
    fireEvent.click(screen.getByTestId("points-trigger"));

    expect((await screen.findByTestId("points-details")).textContent).toContain("35");
    expect(screen.getByTestId("points-pending-poll").textContent).toBe("+120");
  });
});
