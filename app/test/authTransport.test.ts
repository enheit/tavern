import { describe, expect, it, vi } from "vitest";
import type { PlatformBridge } from "@/platform/types";
import { createAuthTransport } from "@/lib/authTransport";

// Builds a full PlatformBridge test double with a controllable secrets store.
function makeBridge(
  kind: PlatformBridge["kind"],
  secrets: PlatformBridge["secrets"],
): PlatformBridge {
  return {
    kind,
    secrets,
    capture: {
      getScreenSources: async () => [],
      selectSource: async () => undefined,
      loopbackAudioSupported: async () => false,
    },
    notifications: {
      show: async () => undefined,
      onClick: () => () => undefined,
    },
    updates: {
      onUpdateReady: () => () => undefined,
      restartToUpdate: () => undefined,
    },
    shell: { setBadge: () => undefined, focusWindow: () => undefined },
  };
}

describe("A5 authTransport", () => {
  it("desktop stores, reads, and clears the bearer token via platform.secrets", async () => {
    const held = { token: null as string | null };
    const secrets = {
      getToken: vi.fn(async () => held.token),
      setToken: vi.fn(async (t: string | null) => {
        held.token = t;
      }),
    };
    const transport = createAuthTransport(makeBridge("desktop", secrets));

    // No token yet → no Authorization header.
    expect(await transport.getAuthHeaders()).toEqual({});

    // Captures the token from the set-auth-token response header.
    await transport.storeFromResponse(new Headers({ "set-auth-token": "abc123" }));
    expect(secrets.setToken).toHaveBeenCalledWith("abc123");
    expect(await transport.getAuthHeaders()).toEqual({ Authorization: "Bearer abc123" });

    // clear() wipes it.
    await transport.clear();
    expect(secrets.setToken).toHaveBeenLastCalledWith(null);
    expect(await transport.getAuthHeaders()).toEqual({});
  });

  it("web is a cookie no-op: no bearer header, storeFromResponse ignores the header", async () => {
    const secrets = {
      getToken: vi.fn(async () => "should-never-be-read"),
      setToken: vi.fn(async () => undefined),
    };
    const transport = createAuthTransport(makeBridge("web", secrets));

    // Cookie mode → never a bearer header, and getToken is never consulted.
    expect(await transport.getAuthHeaders()).toEqual({});
    expect(secrets.getToken).not.toHaveBeenCalled();

    // storeFromResponse is a no-op even when the header is present.
    await transport.storeFromResponse(new Headers({ "set-auth-token": "abc123" }));
    expect(secrets.setToken).not.toHaveBeenCalled();

    // clear() is the one method that still touches the (no-op) secret store.
    await transport.clear();
    expect(secrets.setToken).toHaveBeenCalledWith(null);
  });
});
