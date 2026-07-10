import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatHoursMinutes, formatRelativeTime } from "@/lib/time";

// A fixed clock so each `at` offset maps to an exact diff (no round-off from real elapsed ms).
const NOW = 1_700_000_000_000;

describe("FR-39 relative time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats 5s ago", () => {
    expect(formatRelativeTime(NOW - 5 * 1000, "en")).toBe("5 seconds ago");
  });

  it("formats 59min ago as minutes", () => {
    expect(formatRelativeTime(NOW - 59 * 60 * 1000, "en")).toBe("59 minutes ago");
  });

  it("formats 23h ago as hours", () => {
    expect(formatRelativeTime(NOW - 23 * 60 * 60 * 1000, "en")).toBe("23 hours ago");
  });

  it("formats 3d ago as days", () => {
    expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60 * 1000, "en")).toBe("3 days ago");
  });

  it("formats uk locale", () => {
    const out = formatRelativeTime(NOW - 5 * 1000, "uk");
    // Ukrainian output ("5 секунд тому"), not the English string.
    expect(out).toContain("тому");
    expect(out).not.toBe(formatRelativeTime(NOW - 5 * 1000, "en"));
  });
});

describe("FR-40 hours formatting", () => {
  it("0 → 0:00", () => {
    expect(formatHoursMinutes(0)).toBe("0:00");
  });

  it("59s floors to 0:00", () => {
    expect(formatHoursMinutes(59)).toBe("0:00");
  });

  it("60s → 0:01", () => {
    expect(formatHoursMinutes(60)).toBe("0:01");
  });

  it("3661s → 1:01", () => {
    expect(formatHoursMinutes(3661)).toBe("1:01");
  });

  it("360000s → 100:00", () => {
    expect(formatHoursMinutes(360_000)).toBe("100:00");
  });

  it("445500s → 123:45", () => {
    expect(formatHoursMinutes(445_500)).toBe("123:45");
  });
});
