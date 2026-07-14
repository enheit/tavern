import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@tavern/shared";
import { closeAllRooms, connectRoom, WsNotOpenError } from "@/lib/wsClient";
import { MEDIA_OWNER_STORAGE_KEY } from "@/lib/mediaOwnership";
import { roomStore, resetRoomStores } from "@/stores/room";
import { useServersStore } from "@/stores/servers";

// Minimal WebSocket test double: records sends, exposes emit() to fire lifecycle events.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, ev: unknown): void {
    const set = this.listeners.get(type);
    if (set) for (const cb of set) cb(ev);
  }
}

function lastWs(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error("no WebSocket instance created");
  return ws;
}

function uid(): string {
  return crypto.randomUUID();
}

// A schema-valid hello.ok snapshot with the given member ids.
function helloOk(memberIds: string[]): unknown {
  return {
    t: "hello.ok",
    status: "",
    self: { userId: uid(), username: "user_a", displayName: "Alice", color: "#aabbcc" },
    serverMeta: { id: uid(), nickname: "tavern", adminUserId: uid() },
    members: memberIds.map((id) => ({
      userId: id,
      username: "user_a",
      displayName: "Alice",
      color: "#aabbcc",
      presence: "online",
      isAdmin: false,
      joinedAt: 1,
    })),
    voice: { members: [], sessionStartedAt: null },
    streams: [],
    recording: { active: false },
    lastMessageId: null,
    lastReadMessageId: 0,
    firstUnreadMessageId: null,
    unreadCount: 0,
    costStatus: { usedGB: 0, capGB: 100, blocked: false },
    points: {
      balance: 0,
      pendingPollWinnings: 0,
      currentRatePerMinute: 0,
      activeSources: [],
      today: { day: "2026-07-13", conversation: 0, streaming: 0, watching: 0, total: 0 },
      config: {
        enabled: true,
        basePointsPerMinute: 5,
        streamerBonusPerMinute: 5,
        watcherBonusPerMinute: 5,
        dailyCap: null,
      },
    },
    polls: [],
  };
}

async function flush(): Promise<void> {
  // Drain microtasks so the awaited ticket fetch + WebSocket creation settle under fake timers.
  // Several sequential rounds cover the multi-hop fetch → json → parse chain.
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

let ticketCounter = 0;
let fetchMock: ReturnType<typeof vi.fn>;
let serverId: string;

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  ticketCounter = 0;
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ ticket: `t${++ticketCounter}` }),
  }));
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Math, "random").mockReturnValue(0.5); // deterministic jitter factor = 1.0
  useServersStore.setState({ servers: [], activeServerId: null, connState: {} });
  resetRoomStores();
  sessionStorage.clear();
  serverId = uid();
  useServersStore.setState({ activeServerId: serverId });
});

afterEach(() => {
  closeAllRooms();
  resetRoomStores();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("§6.2 wsClient", () => {
  it("marks an owning replacement document as a media reset until hello.ok", async () => {
    const replacementPerformance = Object.create(performance);
    Object.defineProperty(replacementPerformance, "getEntriesByType", {
      value: vi.fn(() => [{ type: "reload" }]),
    });
    vi.stubGlobal("performance", replacementPerformance);
    sessionStorage.setItem(MEDIA_OWNER_STORAGE_KEY, serverId);

    const conn = connectRoom(serverId);
    await flush();
    const ws = lastWs();
    ws.emit("open", {});
    expect(JSON.parse(ws.sent[0] ?? "null")).toMatchObject({
      t: "hello",
      mediaResume: false,
      mediaReset: true,
    });
    expect(sessionStorage.getItem(MEDIA_OWNER_STORAGE_KEY)).toBe(serverId);

    ws.emit("message", { data: JSON.stringify(helloOk([])) });
    expect(sessionStorage.getItem(MEDIA_OWNER_STORAGE_KEY)).toBeNull();
    conn.close();
  });

  it("backs off 1s,2s,4s… capped at 30s, refetching a ticket each attempt", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const conn = connectRoom(serverId);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);

    // Drop before hello.ok, advancing each computed reconnect delay to spawn the next socket.
    const step = async (): Promise<number> => {
      setTimeoutSpy.mockClear();
      lastWs().emit("close", {});
      expect(conn.status).toBe("reconnecting");
      const delay = Number(setTimeoutSpy.mock.calls[0]?.[1]);
      await vi.advanceTimersByTimeAsync(delay);
      await flush();
      return delay;
    };
    const delays = [
      await step(),
      await step(),
      await step(),
      await step(),
      await step(),
      await step(),
    ];
    // doubling then the 30s cap (attempt 5: 32s → 30s)
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    // one socket + one ticket per attempt (7 total: initial + 6 reconnects)
    expect(MockWebSocket.instances).toHaveLength(7);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    conn.close();
  });

  it("applies ±20% jitter within bounds", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const rand = vi.spyOn(Math, "random");

    rand.mockReturnValue(0); // lower bound → factor 0.8
    const c1 = connectRoom(serverId);
    await flush();
    setTimeoutSpy.mockClear();
    lastWs().emit("close", {});
    expect(Number(setTimeoutSpy.mock.calls[0]?.[1])).toBe(800);
    c1.close();
    closeAllRooms();

    rand.mockReturnValue(0.999999); // near upper bound → factor ~1.2
    MockWebSocket.instances = [];
    const c2 = connectRoom(serverId);
    await flush();
    setTimeoutSpy.mockClear();
    lastWs().emit("close", {});
    const upper = Number(setTimeoutSpy.mock.calls[0]?.[1]);
    expect(upper).toBeGreaterThan(1199);
    expect(upper).toBeLessThan(1200);
    c2.close();
  });

  it("resyncs full state on hello.ok, replacing prior state (no delta merge)", async () => {
    const conn = connectRoom(serverId);
    await flush();
    let ws = lastWs();
    ws.emit("open", {});
    ws.emit("message", { data: JSON.stringify(helloOk([uid()])) });
    expect(conn.status).toBe("open");
    expect(roomStore(serverId).getState().members).toHaveLength(1);

    // Reconnect and resync with a different membership set.
    ws.emit("close", {});
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(MockWebSocket.instances).toHaveLength(2);
    ws = lastWs();
    ws.emit("open", {});
    ws.emit("message", { data: JSON.stringify(helloOk([uid(), uid()])) });
    // REPLACED (2), not merged (would be 3).
    expect(roomStore(serverId).getState().members).toHaveLength(2);
    conn.close();
  });

  it("drops an invalid frame and stays open, surfacing lastProtocolError", async () => {
    const conn = connectRoom(serverId);
    await flush();
    const ws = lastWs();
    ws.emit("open", {});
    ws.emit("message", { data: JSON.stringify(helloOk([uid()])) });
    expect(conn.status).toBe("open");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ws.emit("message", { data: '{"t":"not_a_real_frame"}' });
    expect(conn.status).toBe("open"); // dropped, connection stays open
    expect(errorSpy).toHaveBeenCalled();
    expect(roomStore(serverId).getState().lastProtocolError).toBe("bad_frame");
    conn.close();
  });

  it("throws WsNotOpenError when sending before open, and sends once open", async () => {
    const conn = connectRoom(serverId);
    await flush();
    expect(conn.status).toBe("connecting");
    expect(() => conn.send({ t: "ping" })).toThrow(WsNotOpenError);

    const ws = lastWs();
    ws.emit("open", {});
    ws.emit("message", { data: JSON.stringify(helloOk([uid()])) });
    expect(conn.status).toBe("open");
    conn.send({ t: "ping" });
    expect(ws.sent.some((s) => s.includes('"t":"ping"'))).toBe(true);
    conn.close();
  });

  it("pings on the configured interval once open", async () => {
    const conn = connectRoom(serverId);
    await flush();
    const ws = lastWs();
    ws.emit("open", {});
    ws.emit("message", { data: JSON.stringify(helloOk([uid()])) });
    expect(conn.status).toBe("open");

    const pingCount = (): number => ws.sent.filter((s) => s.includes('"t":"ping"')).length;
    expect(pingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LIMITS.pingIntervalMs);
    expect(pingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(LIMITS.pingIntervalMs);
    expect(pingCount()).toBe(2);
    conn.close();
  });

  it("is re-entrancy safe: a servers-store subscriber reconnecting the same server spawns one socket", async () => {
    // Mirrors the notifications layer (A6): a servers-store subscriber calls connectRoom for the same
    // server on every store change. The first connect writes connState synchronously (setStatus →
    // setConnState), which re-enters this subscriber DURING construction — so the cache must already
    // hold the instance, otherwise an unbounded number of connections is spawned for one server.
    const unsub = useServersStore.subscribe(() => {
      connectRoom(serverId);
    });
    const conn = connectRoom(serverId);
    await flush();
    unsub();
    expect(MockWebSocket.instances).toHaveLength(1);
    // Same cached instance is returned to every caller (one socket per server).
    expect(connectRoom(serverId)).toBe(conn);
    conn.close();
  });
});
