import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate } from "react-router";
import { useBootStore } from "@/features/boot/bootStore";
import { useServersStore } from "@/stores/servers";

// Guards the PUBLIC auth routes (/login, /register): an already-authenticated account must never sit
// on them (it belongs on its server, or /join when it has none). Runs the same boot machine as
// BootGate so a cold load / hard refresh with a live session cookie still resolves — but, unlike the
// gate, it renders the auth page IMMEDIATELY while booting rather than a loader, because the dominant
// visitor here is unauthenticated and should see the form with no flash. Only once boot reaches
// `ready` (which only an authed account reaches) does it forward to the active server, mirroring
// ActiveServerRedirect: /s/:id, or /join when the account has zero joined servers.
export function GuestOnlyGate({ children }: { children: ReactNode }) {
  const phase = useBootStore((s) => s.phase);
  const activeServerId = useServersStore((s) => s.activeServerId);

  useEffect(() => {
    useBootStore.getState().start();
  }, []);

  if (phase === "ready") {
    return <Navigate to={activeServerId !== null ? `/s/${activeServerId}` : "/join"} replace />;
  }
  return <>{children}</>;
}
