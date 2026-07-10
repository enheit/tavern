import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { BootLoader } from "@/features/boot/BootLoader";
import { createAppRouter, routes } from "@/router";
import { useServersStore } from "@/stores/servers";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "tavern");
  useServersStore.setState({ servers: [], activeServerId: null, connState: {} });
});

// The /join page (JoinOrCreatePage) drives TanStack Query mutations, so the tree needs a QueryClient —
// mirrors the provider main.tsx mounts at the app root.
function renderAt(path: string): void {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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

    // The server route guards membership: seed the store with a joined server so it renders the shell
    // (an unknown id redirects to /join — covered in ServerPage.test).
    useServersStore.setState({
      servers: [
        {
          id: "demo",
          nickname: "demo",
          adminUserId: "admin",
          hasPassword: false,
          createdAt: 1,
          joinedAt: 1,
        },
      ],
      activeServerId: "demo",
    });
    renderAt("/s/demo");
    // ServerPage is the heaviest lazy route (shell + panels + room store); under full-suite parallel
    // load its dynamic-import chain can resolve past testing-library's default 1000ms findBy window,
    // so give the async boundary explicit headroom. findBy polls, so a fast success is unaffected.
    expect(await screen.findByTestId("app-shell", {}, { timeout: 10000 })).toBeDefined();
  }, 15000);

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
