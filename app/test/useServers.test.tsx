import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSummary } from "@tavern/shared";

// Mock the two lib seams useServers drives: apiClient (the mutation transport) and wsClient (the socket
// opened on success). The servers store is real.
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
  return { ApiError, apiClient: { post: vi.fn() } };
});
vi.mock("@/lib/wsClient", () => ({ connectRoom: vi.fn(), closeAllRooms: vi.fn() }));

import { ApiError, apiClient } from "@/lib/apiClient";
import { connectRoom } from "@/lib/wsClient";
import { useServers } from "@/features/servers/useServers";
import { useServersStore } from "@/stores/servers";

function summary(over: Partial<ServerSummary> = {}): ServerSummary {
  return {
    id: crypto.randomUUID(),
    nickname: "cavern",
    adminUserId: crypto.randomUUID(),
    hasPassword: false,
    createdAt: 1,
    joinedAt: 1,
    ...over,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  useServersStore.setState({ servers: [], activeServerId: null, connState: {} });
  vi.clearAllMocks();
});

describe("FR-08 FR-09 server mutations", () => {
  it("create posts payload, upserts store, connects ws, resolves id", async () => {
    const created = summary({ nickname: "my-cave" });
    vi.mocked(apiClient.post).mockResolvedValue(created);
    const { result } = renderHook(() => useServers(), { wrapper });

    let id = "";
    await act(async () => {
      id = await result.current.createServer({
        nickname: "my-cave",
        password: "hunter2",
        code: "code-1",
      });
    });

    expect(id).toBe(created.id);
    expect(apiClient.post).toHaveBeenCalledWith("/api/servers", expect.anything(), {
      nickname: "my-cave",
      password: "hunter2",
      code: "code-1",
    });
    expect(useServersStore.getState().servers).toContainEqual(created);
    expect(connectRoom).toHaveBeenCalledWith(created.id);
    expect(result.current.error).toBeNull();
  });

  it("join maps wrong_password to error state", async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new ApiError("wrong_password", 403));
    const { result } = renderHook(() => useServers(), { wrapper });

    await act(async () => {
      await expect(
        result.current.joinServer({ nickname: "locked", password: "nope" }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    expect(result.current.error).toBe("wrong_password");
    expect(useServersStore.getState().servers).toHaveLength(0);
    expect(connectRoom).not.toHaveBeenCalled();
  });
});
