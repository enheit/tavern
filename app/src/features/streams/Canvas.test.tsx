import type { StreamInfo } from "@tavern/shared";
import { computeLayout } from "@tavern/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Canvas } from "@/features/streams/Canvas";
import { resetRoomStores, roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";

// Wrap the real computeLayout so rows stay App-C-correct while we can assert its call args.
vi.mock("@tavern/shared", async (importActual) => {
  const actual = await importActual<typeof import("@tavern/shared")>();
  return { ...actual, computeLayout: vi.fn(actual.computeLayout) };
});

// Stub the tile — Canvas.test asserts layout (rows/order/focus), not tile internals (useWatch).
vi.mock("@/features/streams/StreamTile", () => ({
  StreamTile: ({ stream: tile }: { stream: StreamInfo }) => (
    <div data-testid={`stream-tile-${tile.trackName}`} />
  ),
}));

// jsdom has no ResizeObserver; capture the callback so a test can drive a resize.
let roCb: ResizeObserverCallback | null = null;
class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    roCb = cb;
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

const SRV = "srv";

function stream(trackName: string, over: Partial<StreamInfo> = {}): StreamInfo {
  return { trackName, kind: "screen", userId: "u", hasAudio: false, preset: "1080p30", ...over };
}

function seed(streams: StreamInfo[], focusedTrackName: string | null = null): void {
  useServersStore.setState({ activeServerId: SRV });
  roomStore(SRV).setState({ streams, focusedTrackName });
}

function tileCount(rowTestId: string): number {
  return screen.getByTestId(rowTestId).querySelectorAll('[data-testid^="stream-tile-"]').length;
}

beforeEach(() => {
  roCb = null;
  resetRoomStores();
  useServersStore.setState({ activeServerId: null });
  vi.mocked(computeLayout).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("FR-32 canvas auto-layout", () => {
  it("3 streams render rows [2,1] per App-C", () => {
    seed([stream("s3"), stream("s1"), stream("s2")]);
    render(<Canvas />);
    expect(tileCount("canvas-row-0")).toBe(2);
    expect(tileCount("canvas-row-1")).toBe(1);
    expect(screen.queryByTestId("canvas-row-2")).toBeNull();
  });

  it("6 streams render [3,3]", () => {
    seed([1, 2, 3, 4, 5, 6].map((n) => stream(`s${n}`)));
    render(<Canvas />);
    expect(tileCount("canvas-row-0")).toBe(3);
    expect(tileCount("canvas-row-1")).toBe(3);
  });

  it("tile order is trackName ascending", () => {
    seed([stream("screen:c:1"), stream("screen:a:1"), stream("screen:b:1")]);
    render(<Canvas />);
    const order = screen
      .getAllByTestId(/^stream-tile-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "stream-tile-screen:a:1",
      "stream-tile-screen:b:1",
      "stream-tile-screen:c:1",
    ]);
  });

  it("resize recomputes rows via computeLayout args", () => {
    seed([stream("s1"), stream("s2"), stream("s3")]);
    render(<Canvas />);
    act(() => {
      roCb?.(
        [{ contentRect: { width: 1600, height: 400 } } as unknown as ResizeObserverEntry],
        {} as unknown as ResizeObserver,
      );
    });
    expect(computeLayout).toHaveBeenCalledWith(3, 1600, 400);
  });
});

describe("FR-33 focus mode layout", () => {
  it("focused stream fills the top; others render as thumbnails in the bottom filmstrip", () => {
    seed([stream("s1"), stream("s2"), stream("s3")], "s2");
    render(<Canvas />);
    const canvas = screen.getByTestId("canvas");
    expect(canvas.getAttribute("data-focused")).toBe("true");
    // No grid rows in focus mode.
    expect(screen.queryByTestId("canvas-row-0")).toBeNull();
    const strip = screen.getByTestId("focus-strip");
    expect(strip.querySelectorAll('[data-testid^="stream-tile-"]')).toHaveLength(2);
    // The focused tile renders in the main area (outside the filmstrip), the other two inside it.
    expect(strip.contains(screen.getByTestId("stream-tile-s2"))).toBe(false);
    expect(strip.contains(screen.getByTestId("stream-tile-s1"))).toBe(true);
    expect(strip.contains(screen.getByTestId("stream-tile-s3"))).toBe(true);
  });
});
