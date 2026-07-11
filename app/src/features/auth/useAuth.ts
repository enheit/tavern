import type { ErrorCode, LoginForm, RegisterForm } from "@tavern/shared";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { bootStore } from "@/features/boot/bootStore";

// FR-01 / FR-02 session flow. Plain `apiClient` calls only — no better-auth client in the renderer
// (pinned). `apiClient` already captures the `set-auth-token` header on every response through
// `authTransport.storeFromResponse` (A5, S4.3): on desktop that persists the bearer token, on web
// the same-origin cookie is set by `credentials:'include'`. So a successful sign-in POST is what
// stores the session — logout is the only flow that touches `authTransport` explicitly (`.clear()`).
export interface UseAuth {
  register(input: RegisterForm): Promise<void>; // POST /api/auth-wrap/register, then sign in
  login(input: LoginForm): Promise<void>; // POST /api/auth/sign-in/username
  logout(): Promise<void>; // POST /api/auth/sign-out
  pending: boolean;
  error: ErrorCode | null;
}

const SIGN_IN = "/api/auth/sign-in/username";
const SIGN_OUT = "/api/auth/sign-out";
const REGISTER = "/api/auth-wrap/register";

// The auth endpoints' success bodies are ignored (register chains into sign-in; sign-in/-out only
// matter for their headers/cookies), so parse them through a permissive pass-through schema.
const passthrough = { safeParse: (data: unknown) => ({ success: true as const, data }) };

export function useAuth(): UseAuth {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);

  // Shared pending/error wrapper. A typed `ErrorCode` (server rejection) is surfaced via `error` and
  // swallowed so the form can render it; a transport failure (no `ErrorCode`) is re-thrown so the
  // page can show the generic `error_network` message.
  const run = useCallback(async (task: () => Promise<void>): Promise<void> => {
    setError(null);
    setPending(true);
    try {
      await task();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      setError(code);
      if (code === null) throw err;
    } finally {
      setPending(false);
    }
  }, []);

  const loginCore = useCallback(
    async (input: LoginForm): Promise<void> => {
      try {
        await apiClient.post(SIGN_IN, passthrough, input);
      } catch (err) {
        // sign-in hits better-auth's endpoint directly (kept out of the /api/auth-wrap layer so its
        // D1-backed brute-force rate limit still applies), so a failure carries better-auth's own
        // { code, message } body — not our { error: ErrorCode } shape — and apiClient falls back to
        // the generic `bad_message` ("That message couldn't be sent"). Re-map by status so the form
        // shows a real reason: 429 → rate_limited; 401 → invalid_credentials (the server returns an
        // identical body for wrong-password vs unknown-username, so this stays enumeration-safe).
        if (err instanceof ApiError && err.status === 429) throw new ApiError("rate_limited", 429);
        if (err instanceof ApiError && err.status === 401) {
          throw new ApiError("invalid_credentials", 401);
        }
        throw err;
      }
      bootStore.restart();
      navigate("/");
    },
    [navigate],
  );

  const login = useCallback((input: LoginForm) => run(() => loginCore(input)), [run, loginCore]);

  const register = useCallback(
    (input: RegisterForm) =>
      run(async () => {
        await apiClient.post(REGISTER, passthrough, input);
        // Register success body is ignored — chain straight into the login flow with the same creds.
        await loginCore({ username: input.username, password: input.password });
      }),
    [run, loginCore],
  );

  const logout = useCallback(
    () =>
      run(async () => {
        await apiClient.post(SIGN_OUT, passthrough, {});
        await authTransport.clear();
        bootStore.reset();
        navigate("/login");
      }),
    [run, navigate],
  );

  return { register, login, logout, pending, error };
}
