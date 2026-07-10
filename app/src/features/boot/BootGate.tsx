import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate } from "react-router";
import { BootLoader } from "@/features/boot/BootLoader";
import { useBootStore } from "@/features/boot/bootStore";
import { useServersStore } from "@/stores/servers";

// FR-43 no-flash gate: wraps every route except /login|/register. Renders the boot-loader until the
// machine reaches `ready`, so no feature component mounts before session + active snapshot are in.
export function BootGate({ children }: { children: ReactNode }) {
  const phase = useBootStore((s) => s.phase);
  const serverCount = useServersStore((s) => s.servers.length);

  useEffect(() => {
    useBootStore.getState().start();
  }, []);

  if (phase === "unauthed") return <Navigate to="/login" replace />;
  if (phase !== "ready") return <BootLoader />;
  if (serverCount === 0) return <Navigate to="/join" replace />;
  return <>{children}</>;
}
