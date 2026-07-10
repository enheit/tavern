import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { createAppRouter } from "@/router";
import { useSettingsStore } from "@/stores/settings";
import "@/styles/app.css";

const queryClient = new QueryClient();
const router = createAppRouter();

function Root() {
  // Re-key the whole tree on locale change so Paraglide's compiled messages re-render (§9.6).
  const localeVersion = useSettingsStore((state) => state.localeVersion);
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
