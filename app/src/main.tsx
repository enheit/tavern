import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { bindNotificationsToBootPhase } from "@/features/boot/notificationsLifecycle";
import { createAppRouter } from "@/router";
import { primeUiSounds } from "@/lib/uiSounds";
import { useSettingsStore } from "@/stores/settings";
import "@/styles/app.css";

const queryClient = new QueryClient();
const router = createAppRouter();

function Root() {
  // Re-key the whole tree on locale change so Paraglide's compiled messages re-render (§9.6).
  const localeVersion = useSettingsStore((state) => state.localeVersion);

  // FR-16: notifications live exactly while boot is at `ready`, rebuilt on every return to it (an
  // in-tab logout→login recreates the room sockets). See bindNotificationsToBootPhase.
  useEffect(() => bindNotificationsToBootPhase(), []);
  useEffect(() => primeUiSounds(), []);

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
