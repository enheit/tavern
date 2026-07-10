import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The chat pane's inner components are covered by their own suites; stub them so this suite focuses
// on the tab shell and the coming-soon placeholders for the not-yet-built panes.
vi.mock("@/features/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list-stub" />,
}));
vi.mock("@/features/chat/Composer", () => ({
  Composer: () => <div data-testid="composer-stub" />,
}));
// Activity (S10.1) and Stats (S10.2) are live panes with their own suites + data deps (query client,
// room store, session); stub them here so this suite stays focused on the tab shell wiring.
vi.mock("@/features/activity/ActivityTab", () => ({
  ActivityTab: () => <div data-testid="activity-tab-stub" />,
}));
vi.mock("@/features/stats/StatsTab", () => ({
  StatsTab: ({ active }: { active: boolean }) => (
    <div data-testid="stats-tab-stub" data-active={active} />
  ),
}));

import { ChatTabs } from "@/features/chat/ChatTabs";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
});

describe("FR-14 chat tabs", () => {
  it("defaults to the Chat pane with the message list + composer", () => {
    render(<ChatTabs serverId="s1" />);
    expect(screen.getByTestId("tab-chat")).toBeDefined();
    expect(screen.getByTestId("tab-activity")).toBeDefined();
    expect(screen.getByTestId("tab-stats")).toBeDefined();
    expect(screen.getByTestId("tab-recordings")).toBeDefined();
    expect(screen.getByTestId("message-list-stub")).toBeDefined();
    expect(screen.getByTestId("composer-stub")).toBeDefined();
    expect(screen.queryByTestId("coming-soon")).toBeNull();
  });

  it("renders the Activity pane (not a placeholder) on the Activity tab", async () => {
    render(<ChatTabs serverId="s1" />);
    fireEvent.click(screen.getByTestId("tab-activity"));
    await waitFor(() => expect(screen.getByTestId("activity-tab-stub")).toBeDefined());
    expect(screen.queryByTestId("coming-soon")).toBeNull();
  });

  it("renders the Stats pane (not a placeholder) and marks it active on the Stats tab", async () => {
    render(<ChatTabs serverId="s1" />);
    // The Stats panel stays mounted (keepMounted) but inactive until selected — its query gate.
    expect(screen.getByTestId("stats-tab-stub").getAttribute("data-active")).toBe("false");
    fireEvent.click(screen.getByTestId("tab-stats"));
    await waitFor(() =>
      expect(screen.getByTestId("stats-tab-stub").getAttribute("data-active")).toBe("true"),
    );
    expect(screen.queryByTestId("coming-soon")).toBeNull();
  });
});
