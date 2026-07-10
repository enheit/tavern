import type { ActivityEntry, ActivityType } from "@tavern/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({
  apiClient: { get: (path: string, schema: unknown) => getMock(path, schema) },
}));

import { ActivityTab } from "@/features/activity/ActivityTab";
import { resetRoomStores, roomStore } from "@/stores/room";

// A controllable IntersectionObserver (jsdom has none): tests fire the captured callback to simulate
// the bottom sentinel scrolling into view.
interface IoInstance {
  cb: IntersectionObserverCallback;
  observed: Element[];
}
let ioInstances: IoInstance[] = [];
class IoStub {
  private readonly self: IoInstance;
  constructor(cb: IntersectionObserverCallback) {
    this.self = { cb, observed: [] };
    ioInstances.push(this.self);
  }
  observe(el: Element): void {
    this.self.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function fireSentinel(): void {
  const io = ioInstances.at(-1);
  if (io === undefined) throw new Error("no IntersectionObserver was created");
  act(() => {
    io.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

function entry(id: number, type: ActivityType = "voice.join"): ActivityEntry {
  return { id, type, userId: "u1", meta: {}, at: id };
}

let sid = "";
function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <ActivityTab serverId={sid} />
    </QueryClientProvider>
  );
  render(ui);
}

function rowIds(): number[] {
  return screen
    .getAllByTestId("activity-row")
    .map((el) => Number(el.getAttribute("data-activity-id")));
}

beforeEach(() => {
  Reflect.set(globalThis, "IntersectionObserver", IoStub);
  ioInstances = [];
  getMock.mockReset();
  resetRoomStores();
  sid = `s-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  cleanup();
});

describe("FR-39 activity tab", () => {
  it("renders first page newest-first", async () => {
    // DO returns a page oldest→newest; the tab sorts id DESC.
    getMock.mockResolvedValue({ entries: [entry(10), entry(11)], hasMore: false });
    renderTab();
    await waitFor(() => expect(rowIds()).toEqual([11, 10]));
  });

  it("appends older page on sentinel intersect", async () => {
    getMock.mockImplementation((path: string) =>
      path.includes("before=")
        ? Promise.resolve({ entries: [entry(5), entry(6)], hasMore: false })
        : Promise.resolve({ entries: [entry(20), entry(21)], hasMore: true }),
    );
    renderTab();
    await waitFor(() => expect(rowIds()).toEqual([21, 20]));
    fireSentinel();
    await waitFor(() => expect(rowIds()).toEqual([21, 20, 6, 5]));
    // Older page was fetched with the lowest id of the first page as the cursor.
    expect(getMock.mock.calls.some(([path]) => String(path).includes("before=20"))).toBe(true);
  });

  it("prepends live activity.new entry", async () => {
    getMock.mockResolvedValue({ entries: [entry(5)], hasMore: false });
    renderTab();
    await waitFor(() => expect(rowIds()).toEqual([5]));
    act(() => {
      roomStore(sid)
        .getState()
        .apply({ t: "activity.new", entry: entry(9) });
    });
    await waitFor(() => expect(rowIds()).toEqual([9, 5]));
  });

  it("dedups entry present in both tail and page", async () => {
    getMock.mockResolvedValue({ entries: [entry(5)], hasMore: false });
    // Same id 5 arrives via the live tail as well.
    roomStore(sid).getState().appendActivity(entry(5));
    renderTab();
    await waitFor(() => expect(rowIds()).toEqual([5]));
    expect(screen.getAllByTestId("activity-row")).toHaveLength(1);
  });

  it("shows empty state", async () => {
    getMock.mockResolvedValue({ entries: [], hasMore: false });
    renderTab();
    await waitFor(() => expect(screen.getByTestId("activity-empty")).toBeDefined());
  });
});
