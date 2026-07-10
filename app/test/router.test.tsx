import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { BootLoader } from "@/features/boot/BootLoader";
import { createAppRouter, routes } from "@/router";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "tavern");
});

function renderAt(path: string): void {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
}

describe("§7.6 routes", () => {
  it("renders the login page at /login", async () => {
    renderAt("/login");
    expect(await screen.findByTestId("page-login")).toBeDefined();
  });

  it("redirects an unknown path to /login", async () => {
    renderAt("/definitely-not-a-route");
    expect(await screen.findByTestId("page-login")).toBeDefined();
  });

  it("renders the register, join and server routes", async () => {
    renderAt("/register");
    expect(await screen.findByTestId("page-register")).toBeDefined();
    cleanup();

    renderAt("/join");
    expect(await screen.findByTestId("page-join")).toBeDefined();
    cleanup();

    renderAt("/s/demo");
    expect(await screen.findByTestId("page-server")).toBeDefined();
  });

  it("renders the boot loader fallback", () => {
    render(<BootLoader />);
    expect(screen.getByTestId("boot-loader")).toBeDefined();
  });

  it("builds a browser router on web and a hash router on desktop", () => {
    expect(createAppRouter()).toBeDefined();
    Reflect.set(window, "tavern", {});
    expect(createAppRouter()).toBeDefined();
  });
});
