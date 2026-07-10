import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsConnection } from "@/lib/wsClient";

// Mock the lib seams the boot machine drives; the machine + stores under test are real.
vi.mock("@/lib/apiClient", () => {
  class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  return {
    ApiError,
    apiClient: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      del: vi.fn(),
      upload: vi.fn(),
    },
  };
});
vi.mock("@/lib/authTransport", () => ({
  authTransport: {
    clear: vi.fn(async () => undefined),
    getAuthHeaders: vi.fn(async () => ({})),
    storeFromResponse: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/wsClient", () => ({
  connectRoom: vi.fn(),
  closeAllRooms: vi.fn(),
}));

import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { connectRoom } from "@/lib/wsClient";
import { BootGate } from "@/features/boot/BootGate";
import { useBootStore } from "@/features/boot/bootStore";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";

function uid(): string {
  return crypto.randomUUID();
}

function serverSummary(): unknown {
  return {
    id: uid(),
    nickname: "tavern",
    adminUserId: uid(),
    hasPassword: false,
    createdAt: 1,
    joinedAt: 1,
  };
}

function meResponse(servers: unknown[]): unknown {
  return {
    user: { userId: uid(), username: "user_a", displayName: "Alice", color: "#aabbcc" },
    settings: { notifyAll: true, notifyMentions: true, locale: "en", theme: "system" },
    servers,
  };
}

function renderGate() {
  return render(
    <MemoryRouter initialEntries={["/s/abc"]}>
      <Routes>
        <Route
          path="/s/:id"
          element={
            <BootGate>
              <div data-testid="page-server" />
            </BootGate>
          }
        />
        <Route path="/login" element={<div data-testid="page-login" />} />
        <Route path="/join" element={<div data-testid="page-join" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useBootStore.getState().reset(); // clears the internal running flag + resets stores
  useBootStore.setState({ phase: "loading" });
  useSessionStore.setState({ status: "booting", profile: null });
  useServersStore.setState({ servers: [], activeServerId: null, connState: {} });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FR-43 boot gate", () => {
  it("no token → routes to login (loader never falls through to a page)", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new ApiError("unauthorized", 401));
    renderGate();
    await screen.findByTestId("page-login");
    expect(screen.queryByTestId("page-server")).toBeNull();
  });

  it("401 on /api/me drops to unauthed and clears the token", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new ApiError("unauthorized", 401));
    renderGate();
    await screen.findByTestId("page-login");
    expect(authTransport.clear).toHaveBeenCalled();
  });

  it("happy path shows the loader until the active hello.ok, then ready", async () => {
    vi.mocked(apiClient.get).mockResolvedValue(meResponse([serverSummary()]));
    let helloCb: (() => void) | null = null;
    const fakeConn = {
      status: "connecting",
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((t: string, cb: () => void) => {
        if (t === "hello.ok") helloCb = cb;
        return () => undefined;
      }),
    };
    vi.mocked(connectRoom).mockReturnValue(fakeConn as unknown as WsConnection);

    renderGate();
    await waitFor(() => expect(connectRoom).toHaveBeenCalled());
    // Loader is up, the active server's hello.ok has not arrived → no feature page yet.
    expect(screen.getByTestId("boot-loader")).toBeTruthy();
    expect(screen.queryByTestId("page-server")).toBeNull();

    await act(async () => {
      helloCb?.();
      await Promise.resolve();
    });
    await screen.findByTestId("page-server");
  });

  it("zero joined servers → ready routes to /join", async () => {
    vi.mocked(apiClient.get).mockResolvedValue(meResponse([]));
    renderGate();
    await screen.findByTestId("page-join");
    expect(connectRoom).not.toHaveBeenCalled();
  });

  it("shows only the loader before ready — no feature page mounts early", async () => {
    vi.mocked(apiClient.get).mockResolvedValue(meResponse([serverSummary()]));
    const fakeConn = {
      status: "connecting",
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(() => () => undefined),
    };
    vi.mocked(connectRoom).mockReturnValue(fakeConn as unknown as WsConnection);

    renderGate();
    await waitFor(() => expect(connectRoom).toHaveBeenCalled());
    // hello.ok never fires → machine stays at connectingActive; only the loader is visible.
    expect(screen.getByTestId("boot-loader")).toBeTruthy();
    expect(screen.queryByTestId("page-server")).toBeNull();
    expect(screen.queryByTestId("page-login")).toBeNull();
    expect(screen.queryByTestId("page-join")).toBeNull();
  });
});
