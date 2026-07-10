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

  it("shows a coming-soon placeholder for the other panes", async () => {
    render(<ChatTabs serverId="s1" />);
    fireEvent.click(screen.getByTestId("tab-activity"));
    await waitFor(() => expect(screen.getByTestId("coming-soon")).toBeDefined());
  });
});
