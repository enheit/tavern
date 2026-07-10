import {
  createBrowserRouter,
  createHashRouter,
  Navigate,
  redirect,
  type RouteObject,
} from "react-router";
import { BootGate } from "@/features/boot/BootGate";
import { BootLoader } from "@/features/boot/BootLoader";
import { useServersStore } from "@/stores/servers";

// The index route is the only gated entry point: the S4.3 BootGate runs the boot machine and sends
// an unauthed visitor to /login, a member with zero servers to /join, and otherwise renders its child
// which forwards to the active server. /login and /register stay PUBLIC (outside the gate); a fresh
// login navigates back to "/" so the gate re-routes from there.
function HomeRoute() {
  return (
    <BootGate>
      <ActiveServerRedirect />
    </BootGate>
  );
}

// Rendered only once the gate is `ready` with ≥1 joined server (0 servers → the gate itself routes to
// /join). Forwards to the active server picked by the boot machine.
function ActiveServerRedirect() {
  const activeServerId = useServersStore((state) => state.activeServerId);
  return <Navigate to={activeServerId !== null ? `/s/${activeServerId}` : "/join"} replace />;
}

// react-router 8 in DATA mode (§7.6). Lazy routes use NAMED exports (§9.3); the root layout route
// renders an implicit <Outlet/> and shows BootLoader while a child module resolves.
export const routes: RouteObject[] = [
  {
    path: "/",
    HydrateFallback: BootLoader,
    children: [
      { index: true, Component: HomeRoute },
      {
        path: "login",
        lazy: async () => ({ Component: (await import("@/features/auth/LoginPage")).LoginPage }),
      },
      {
        path: "register",
        lazy: async () => ({
          Component: (await import("@/features/auth/RegisterPage")).RegisterPage,
        }),
      },
      {
        path: "join",
        lazy: async () => ({
          Component: (await import("@/features/servers/JoinOrCreatePage")).JoinOrCreatePage,
        }),
      },
      {
        path: "s/:serverId",
        lazy: async () => ({
          Component: (await import("@/features/servers/ServerPage")).ServerPage,
        }),
      },
      { path: "*", loader: () => redirect("/login") },
    ],
  },
];

export function createAppRouter() {
  // Desktop runs from a file:// origin (hash history); the web build uses browser history (§7.6).
  return typeof window !== "undefined" && "tavern" in window
    ? createHashRouter(routes)
    : createBrowserRouter(routes);
}
