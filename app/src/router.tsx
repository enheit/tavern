import { createBrowserRouter, createHashRouter, redirect, type RouteObject } from "react-router";
import { BootLoader } from "@/features/boot/BootLoader";

// react-router 8 in DATA mode (§7.6). Lazy routes use NAMED exports (§9.3); the root layout route
// renders an implicit <Outlet/> and shows BootLoader while a child module resolves.
export const routes: RouteObject[] = [
  {
    path: "/",
    HydrateFallback: BootLoader,
    children: [
      { index: true, loader: () => redirect("/login") },
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
        lazy: async () => ({ Component: (await import("@/features/servers/JoinPage")).JoinPage }),
      },
      {
        path: "s/:serverId",
        lazy: async () => ({ Component: (await import("@/features/shell/ServerPage")).ServerPage }),
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
