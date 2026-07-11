import {
  createBrowserRouter,
  createHashRouter,
  Navigate,
  Outlet,
  redirect,
  type RouteObject,
} from "react-router";
import { BootGate } from "@/features/boot/BootGate";
import { BootLoader } from "@/features/boot/BootLoader";
import { useServersStore } from "@/stores/servers";

// FR-43 no-flash boot: every gated route — the index, /join, and /s/:serverId — runs through the
// S4.3 BootGate so a cold load / refresh / deep-link resolves session + server list + the active
// snapshot BEFORE any feature component decides where to route. Without this, a refresh on
// /s/:serverId hit ServerPage against the empty (non-persisted) servers store and bounced to /join.
// /login and /register stay PUBLIC (outside the gate); a fresh login navigates back to "/".
function GatedLayout() {
  return (
    <BootGate>
      <Outlet />
    </BootGate>
  );
}

// Index route: once the gate is `ready`, forward to the active server the boot machine picked, or to
// /join when the account has zero joined servers (activeServerId stays null).
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
        Component: GatedLayout,
        children: [
          { index: true, Component: ActiveServerRedirect },
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
        ],
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
