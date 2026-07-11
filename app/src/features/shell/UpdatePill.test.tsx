import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Platform bridge double (§9.1): tests fire the captured onUpdateReady callback to simulate the
// desktop main's update://ready push.
const platformMock = vi.hoisted(() => {
  const callbacks = new Set<(info: { version: string }) => void>();
  return {
    callbacks,
    platform: {
      updates: {
        onUpdateReady: vi.fn((cb: (info: { version: string }) => void) => {
          callbacks.add(cb);
          return () => {
            callbacks.delete(cb);
          };
        }),
        restartToUpdate: vi.fn(),
      },
    },
  };
});
vi.mock("@/platform/types", () => ({ platform: platformMock.platform }));

import { UpdatePill } from "@/features/shell/UpdatePill";

function fireUpdateReady(version: string): void {
  act(() => {
    for (const cb of platformMock.callbacks) cb({ version });
  });
}

beforeEach(() => {
  platformMock.callbacks.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FR-44 update pill", () => {
  it("is hidden until an update is ready", () => {
    render(<UpdatePill />);
    expect(screen.queryByTestId("update-pill")).toBeNull();
  });

  it("renders the downloaded version after onUpdateReady", () => {
    render(<UpdatePill />);
    fireUpdateReady("0.1.1");
    expect(screen.getByTestId("update-pill").textContent).toContain("0.1.1");
  });

  it("click hands off to restartToUpdate", () => {
    render(<UpdatePill />);
    fireUpdateReady("0.1.1");
    fireEvent.click(screen.getByTestId("update-pill"));
    expect(platformMock.platform.updates.restartToUpdate).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes from the bridge on unmount", () => {
    const { unmount } = render(<UpdatePill />);
    expect(platformMock.callbacks.size).toBe(1);
    unmount();
    expect(platformMock.callbacks.size).toBe(0);
  });
});
