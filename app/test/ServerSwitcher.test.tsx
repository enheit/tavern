import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSummary } from "@tavern/shared";

// ServerSwitcher navigates via react-router's useNavigate — mock it to a spy so the switcher can be
// exercised without a router. The Base UI menu is real.
const navigateSpy = vi.fn();
vi.mock("react-router", () => ({ useNavigate: () => navigateSpy }));

import { ServerSwitcher } from "@/features/servers/ServerSwitcher";
import { useServersStore } from "@/stores/servers";

// Base UI's menu positioner uses ResizeObserver / scrollIntoView, which jsdom lacks (test doubles).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeAll(() => {
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
  Reflect.set(Element.prototype, "scrollIntoView", () => undefined);
});

function summary(id: string, nickname: string): ServerSummary {
  return {
    id,
    nickname,
    adminUserId: crypto.randomUUID(),
    hasPassword: false,
    createdAt: 1,
    joinedAt: 1,
  };
}

beforeEach(() => {
  useServersStore.setState({
    servers: [summary("s-a", "alpha"), summary("s-b", "bravo")],
    activeServerId: "s-a",
    connState: {},
  });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("FR-41 server switcher", () => {
  it("lists joined servers and check-marks the active one", async () => {
    render(<ServerSwitcher />);
    fireEvent.click(screen.getByTestId("server-switcher"));

    await waitFor(() => expect(screen.getByTestId("server-item-s-a")).toBeDefined());
    expect(screen.getByTestId("server-item-s-b")).toBeDefined();
    expect(screen.getByTestId("server-check-s-a")).toBeDefined();
    expect(screen.queryByTestId("server-check-s-b")).toBeNull();
  });

  it("join-or-create item navigates /join", async () => {
    render(<ServerSwitcher />);
    fireEvent.click(screen.getByTestId("server-switcher"));

    const add = await screen.findByTestId("server-switcher-add");
    fireEvent.click(add);
    expect(navigateSpy).toHaveBeenCalledWith("/join");
  });
});
