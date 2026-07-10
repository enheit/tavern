import type { PlatformBridge } from "@/platform/types";
import { platform } from "@/platform/types";

// A5 — the one seam hiding the desktop-bearer vs web-cookie session difference. Desktop persists
// the token via platform.secrets and captures it from the `set-auth-token` response header; web
// relies entirely on same-origin cookies.
export interface AuthTransport {
  getAuthHeaders(): Promise<Record<string, string>>;
  storeFromResponse(headers: Headers): Promise<void>; // reads 'set-auth-token' (desktop only)
  clear(): Promise<void>;
}

export function createAuthTransport(bridge: PlatformBridge): AuthTransport {
  if (bridge.kind === "web") {
    return {
      getAuthHeaders: async () => ({}),
      storeFromResponse: async () => {
        // web uses same-origin cookies — there is no bearer token to capture.
      },
      clear: async () => {
        await bridge.secrets.setToken(null);
      },
    };
  }
  return {
    getAuthHeaders: async () => {
      const token = await bridge.secrets.getToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    storeFromResponse: async (headers) => {
      const token = headers.get("set-auth-token");
      if (token) await bridge.secrets.setToken(token);
    },
    clear: async () => {
      await bridge.secrets.setToken(null);
    },
  };
}

export const authTransport = createAuthTransport(platform);
