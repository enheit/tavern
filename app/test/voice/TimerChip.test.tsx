import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimerChip } from "@/features/voice/TimerChip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FR-24 timer", () => {
  it("65s → 01:05", () => {
    vi.useFakeTimers();
    const base = 1_000_000;
    vi.setSystemTime(base);
    render(<TimerChip sessionStartedAt={base - 65_000} />);
    expect(screen.getByTestId("voice-timer").textContent).toBe("01:05");
  });

  it("3661s → 1:01:01", () => {
    vi.useFakeTimers();
    const base = 5_000_000;
    vi.setSystemTime(base);
    render(<TimerChip sessionStartedAt={base - 3_661_000} />);
    expect(screen.getByTestId("voice-timer").textContent).toBe("1:01:01");
  });

  it("hidden when sessionStartedAt null", () => {
    render(<TimerChip sessionStartedAt={null} />);
    expect(screen.queryByTestId("voice-timer")).toBeNull();
  });
});
