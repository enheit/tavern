import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PasswordInput } from "@/components/password-input";
import { m } from "@/paraglide/messages.js";

afterEach(cleanup);

describe("PasswordInput visibility toggle", () => {
  it("renders a masked input with a show-password toggle", () => {
    render(<PasswordInput data-testid="input-password" />);
    expect(screen.getByTestId("input-password").getAttribute("type")).toBe("password");
    expect(screen.getByRole("button", { name: m.common_show_password() })).toBeTruthy();
  });

  it("reveals and re-masks the value on toggle clicks", () => {
    render(<PasswordInput data-testid="input-password" />);
    const input = screen.getByTestId("input-password");

    fireEvent.click(screen.getByRole("button", { name: m.common_show_password() }));
    expect(input.getAttribute("type")).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: m.common_hide_password() }));
    expect(input.getAttribute("type")).toBe("password");
  });

  it("keeps the typed value across toggling", () => {
    render(<PasswordInput data-testid="input-password" />);
    const input = screen.getByTestId("input-password") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: m.common_show_password() }));
    expect(input.value).toBe("hunter22");
  });
});
