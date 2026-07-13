import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/chat/MessageList", () => ({
  MessageList: ({ active }: { active: boolean }) => (
    <div data-testid="message-list-stub" data-active={String(active)} />
  ),
}));
vi.mock("@/features/chat/Composer", () => ({
  Composer: () => <div data-testid="composer-stub" />,
}));

import { ChatPanel } from "@/features/chat/ChatPanel";

afterEach(() => cleanup());

describe("persistent chat panel", () => {
  it("renders chat directly with no tabs or heading", () => {
    render(<ChatPanel serverId="s1" />);

    expect(screen.getByTestId("message-list-stub").dataset.active).toBe("true");
    expect(screen.getByTestId("composer-stub")).toBeDefined();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("Chat", { selector: "h1, h2, h3" })).toBeNull();
  });
});
