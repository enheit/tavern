import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import type { BootPhase } from "@/features/boot/bootStore";
import { useBootStore } from "@/features/boot/bootStore";
import { initNotifications } from "@/lib/notifications";
import { createAppRouter } from "@/router";
import { useSettingsStore } from "@/stores/settings";
import "@/styles/app.css";

const queryClient = new QueryClient();
const router = createAppRouter();

function Root() {
  // Re-key the whole tree on locale change so Paraglide's compiled messages re-render (§9.6).
  const localeVersion = useSettingsStore((state) => state.localeVersion);

  // FR-16: start notifications once the boot machine reaches `ready` (session + joined servers are in
  // and every room socket is opening) and tear them down on unmount.
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    const maybeStart = (phase: BootPhase): void => {
      if (phase === "ready" && cleanup === null) cleanup = initNotifications();
    };
    maybeStart(useBootStore.getState().phase);
    const unsubscribe = useBootStore.subscribe((state) => maybeStart(state.phase));
    return () => {
      unsubscribe();
      cleanup?.();
      cleanup = null;
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider key={localeVersion} router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root is missing from index.html");
}
createRoot(rootElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
