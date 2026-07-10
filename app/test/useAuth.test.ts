import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// react-router's useNavigate is the only browser seam useAuth needs; mock it to a spy so the hook can
// run without a Router. apiClient / authTransport / bootStore are the other three seams (§10).
const navigateSpy = vi.fn();
vi.mock("react-router", () => ({ useNavigate: () => navigateSpy }));

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
      put: vi.fn(),
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
vi.mock("@/features/boot/bootStore", () => ({
  bootStore: { restart: vi.fn(), reset: vi.fn() },
}));

import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { bootStore } from "@/features/boot/bootStore";
import { useAuth } from "@/features/auth/useAuth";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FR-02 session flow", () => {
  it("login stores token from response and restarts boot", async () => {
    // apiClient centralizes the `set-auth-token` capture (A5, S4.3), so a successful sign-in POST is
    // exactly what persists the session — assert that POST fired, then that boot restarts + routes to /.
    vi.mocked(apiClient.post).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.login({ username: "chris", password: "secret12" });
    });

    expect(apiClient.post).toHaveBeenCalledWith("/api/auth/sign-in/username", expect.anything(), {
      username: "chris",
      password: "secret12",
    });
    expect(bootStore.restart).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith("/");
    expect(authTransport.clear).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("logout clears transport, resets boot, navigates /login", async () => {
    vi.mocked(apiClient.post).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.logout();
    });

    expect(apiClient.post).toHaveBeenCalledWith("/api/auth/sign-out", expect.anything(), {});
    expect(authTransport.clear).toHaveBeenCalledTimes(1);
    expect(bootStore.reset).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith("/login");
  });

  it("register chains into login with same credentials", async () => {
    vi.mocked(apiClient.post).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.register({
        username: "newbie",
        password: "secret12",
        repeatPassword: "secret12",
      });
    });

    expect(apiClient.post).toHaveBeenNthCalledWith(
      1,
      "/api/auth-wrap/register",
      expect.anything(),
      {
        username: "newbie",
        password: "secret12",
        repeatPassword: "secret12",
      },
    );
    expect(apiClient.post).toHaveBeenNthCalledWith(
      2,
      "/api/auth/sign-in/username",
      expect.anything(),
      { username: "newbie", password: "secret12" },
    );
    expect(bootStore.restart).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith("/");
  });

  it("surfaces a server ErrorCode and does not navigate or restart boot", async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new ApiError("invalid_credentials", 401));
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.login({ username: "chris", password: "wrong" });
    });

    expect(result.current.error).toBe("invalid_credentials");
    expect(bootStore.restart).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("re-throws a transport failure (no ErrorCode) so the page can show error_network", async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useAuth());

    await expect(
      act(async () => {
        await result.current.login({ username: "chris", password: "secret12" });
      }),
    ).rejects.toThrow("network down");

    expect(result.current.error).toBeNull();
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
