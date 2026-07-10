import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UseAuth } from "@/features/auth/useAuth";

vi.mock("@/features/auth/useAuth", () => ({ useAuth: vi.fn() }));

import { m } from "@/paraglide/messages.js";
import { LoginPage } from "@/features/auth/LoginPage";
import { useAuth } from "@/features/auth/useAuth";

function authDouble(overrides: Partial<UseAuth> = {}): UseAuth {
  return {
    register: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    pending: false,
    error: null,
    ...overrides,
  };
}

function renderLogin(): void {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FR-02 login form", () => {
  it("submits credentials to useAuth.login", async () => {
    const login = vi.fn(async () => undefined);
    vi.mocked(useAuth).mockReturnValue(authDouble({ login }));
    renderLogin();

    fireEvent.change(screen.getByTestId("input-username"), { target: { value: "chris" } });
    fireEvent.change(screen.getByTestId("input-password"), { target: { value: "secret12" } });
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({ username: "chris", password: "secret12" }),
    );
  });

  it("shows errorMessage('invalid_credentials') on 401 without naming the wrong field", () => {
    vi.mocked(useAuth).mockReturnValue(authDouble({ error: "invalid_credentials" }));
    renderLogin();

    const slot = screen.getByTestId("form-error");
    expect(slot.textContent).toBe(m.error_invalid_credentials());
    // Generic message: neither the username nor the password field is singled out as wrong.
    expect(screen.queryByTestId("error-username")).toBeNull();
    expect(screen.queryByTestId("error-password")).toBeNull();
  });

  it("has pinned autocomplete attributes", () => {
    vi.mocked(useAuth).mockReturnValue(authDouble());
    renderLogin();

    expect(screen.getByTestId("input-username").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByTestId("input-password").getAttribute("autocomplete")).toBe(
      "current-password",
    );
  });
});
