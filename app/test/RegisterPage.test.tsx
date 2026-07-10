import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UseAuth } from "@/features/auth/useAuth";

vi.mock("@/features/auth/useAuth", () => ({ useAuth: vi.fn() }));

import { m } from "@/paraglide/messages.js";
import { RegisterPage } from "@/features/auth/RegisterPage";
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

function renderRegister(): void {
  render(
    <MemoryRouter initialEntries={["/register"]}>
      <RegisterPage />
    </MemoryRouter>,
  );
}

function fill(username: string, password: string, repeatPassword: string): void {
  fireEvent.change(screen.getByTestId("input-username"), { target: { value: username } });
  fireEvent.change(screen.getByTestId("input-password"), { target: { value: password } });
  fireEvent.change(screen.getByTestId("input-repeat-password"), {
    target: { value: repeatPassword },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FR-01 register form", () => {
  it("shows m.error_username_invalid for 'ab'", async () => {
    const register = vi.fn(async () => undefined);
    vi.mocked(useAuth).mockReturnValue(authDouble({ register }));
    renderRegister();

    fill("ab", "password1", "password1");
    fireEvent.click(screen.getByTestId("submit"));

    const slot = await screen.findByTestId("error-username");
    expect(slot.textContent).toBe(m.error_username_invalid());
    expect(register).not.toHaveBeenCalled();
  });

  it("shows m.error_password_too_short for 7-char password", async () => {
    vi.mocked(useAuth).mockReturnValue(authDouble());
    renderRegister();

    fill("chris", "1234567", "1234567");
    fireEvent.click(screen.getByTestId("submit"));

    const slot = await screen.findByTestId("error-password");
    expect(slot.textContent).toBe(m.error_password_too_short());
  });

  it("shows m.error_password_mismatch when repeat differs", async () => {
    vi.mocked(useAuth).mockReturnValue(authDouble());
    renderRegister();

    fill("chris", "password1", "password2");
    fireEvent.click(screen.getByTestId("submit"));

    const slot = await screen.findByTestId("error-repeat-password");
    expect(slot.textContent).toBe(m.error_password_mismatch());
  });

  it("lowercases username input and submits full payload to useAuth.register", async () => {
    const register = vi.fn(async () => undefined);
    vi.mocked(useAuth).mockReturnValue(authDouble({ register }));
    renderRegister();

    fill("ABChris", "password1", "password1");
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        username: "abchris",
        password: "password1",
        repeatPassword: "password1",
      }),
    );
  });

  it("renders m.error_username_taken when register rejects with that code", () => {
    vi.mocked(useAuth).mockReturnValue(authDouble({ error: "username_taken" }));
    renderRegister();

    expect(screen.getByTestId("form-error").textContent).toBe(m.error_username_taken());
  });
});
