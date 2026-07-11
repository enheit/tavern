import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { BootLoader } from "@/features/boot/BootLoader";
import { useBootStore } from "@/features/boot/bootStore";
import { createAppRouter, routes } from "@/router";
import { useServersStore } from "@/stores/servers";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "tavern");
  useServersStore.setState({ servers: [], activeServerId: null, connState: {} });
  // FR-43: /join and /s/:serverId are behind the boot gate; reset the machine between tests.
  useBootStore.setState({ phase: "loading" });
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
  // Lazy routes resolve a dynamic-import chain; under full-suite parallel load that can pass
  // testing-library's default 1000ms findBy window (same reason the app-shell case below already has
  // headroom), so every lazy-route findBy gets an explicit timeout. findBy polls — a fast success is
  // unaffected; this only tolerates slow-under-load resolution (no assertion is weakened).
  const LAZY_TIMEOUT = { timeout: 10000 } as const;

  it("renders the login page at /login", async () => {
    // /login sits under GuestOnlyLayout; an `unauthed` account sees the form and GuestOnlyGate does
    // NOT restart the boot machine (it only starts from `loading`), so the render stays deterministic.
    useBootStore.setState({ phase: "unauthed" });
    renderAt("/login");
    expect(await screen.findByTestId("page-login", {}, LAZY_TIMEOUT)).toBeDefined();
  }, 15000);

  it("redirects an unknown path to /login", async () => {
    useBootStore.setState({ phase: "unauthed" });
    renderAt("/definitely-not-a-route");
    expect(await screen.findByTestId("page-login", {}, LAZY_TIMEOUT)).toBeDefined();
  }, 15000);

  it("renders the register, join and server routes", async () => {
    useBootStore.setState({ phase: "unauthed" });
    renderAt("/register");
    expect(await screen.findByTestId("page-register", {}, LAZY_TIMEOUT)).toBeDefined();
    cleanup();

    // /join and /s/:serverId now sit behind the FR-43 boot gate; seed the machine to `ready` so the
    // gate renders its child (the machine's own network path is exercised in bootStore.test).
    useBootStore.setState({ phase: "ready" });

    renderAt("/join");
    expect(await screen.findByTestId("page-join", {}, LAZY_TIMEOUT)).toBeDefined();
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

  it("FR-43: a cold load of /s/:serverId shows the boot loader, never /join", async () => {
    // The regression: with an empty (non-persisted) servers store, /s/:id used to render ServerPage
    // directly and bounce to /join. Now it is behind the boot gate. Seed a mid-boot phase (machine
    // already started, not yet ready) so the gate renders the loader deterministically — and assert
    // it is NOT the join page.
    useBootStore.setState({ phase: "loadingMe" });
    renderAt("/s/some-server");
    expect(await screen.findByTestId("boot-loader", {}, LAZY_TIMEOUT)).toBeDefined();
    expect(screen.queryByTestId("page-join")).toBeNull();
  }, 15000);

  it("bounces an authed account off /login to /join when it has no server", async () => {
    // GuestOnlyLayout guard: a `ready` (authed) account must not linger on the auth pages. With zero
    // joined servers it lands on /join (mirroring ActiveServerRedirect), never the login form.
    useBootStore.setState({ phase: "ready" });
    useServersStore.setState({ servers: [], activeServerId: null, connState: {} });
    renderAt("/login");
    expect(await screen.findByTestId("page-join", {}, LAZY_TIMEOUT)).toBeDefined();
    expect(screen.queryByTestId("page-login")).toBeNull();
  }, 15000);

  it("bounces an authed account off /join to its server once it has one", async () => {
    // RequireNoServerLayout guard (one-server-per-user): /join is first-run only, so an account that
    // already has a server is redirected to /s/:id.
    useBootStore.setState({ phase: "ready" });
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
      connState: {},
    });
    renderAt("/join");
    expect(await screen.findByTestId("app-shell", {}, { timeout: 10000 })).toBeDefined();
    expect(screen.queryByTestId("page-join")).toBeNull();
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
