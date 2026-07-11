import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate } from "react-router";
import { BootError } from "@/features/boot/BootError";
import { BootLoader } from "@/features/boot/BootLoader";
import { useBootStore } from "@/features/boot/bootStore";
import { resumeVoiceSession } from "@/features/voice/voiceResume";

// FR-43 no-flash gate: wraps every gated route (index, /join, /s/:serverId) — see router.tsx. Runs
// the boot machine and renders the boot-loader until it reaches `ready`, so no feature component
// mounts before session + server list + the active snapshot are in. Post-`ready` routing (zero
// servers → /join, active-server redirect, /s/:serverId membership) is the child routes' job, so a
// deep-linked /s/:id or a refresh on /join resolves correctly instead of being force-redirected here.
export function BootGate({ children }: { children: ReactNode }) {
  const phase = useBootStore((s) => s.phase);

  useEffect(() => {
    useBootStore.getState().start();
  }, []);

  // Refresh auto-resume: once the boot machine lands on `ready` (session + servers + active socket
  // in), rejoin the persisted voice session. Internally once-per-page-load, so re-renders and the
  // StrictMode double-effect are safe.
  useEffect(() => {
    if (phase === "ready") void resumeVoiceSession();
  }, [phase]);

  if (phase === "unauthed") return <Navigate to="/login" replace />;
  if (phase === "error") return <BootError />;
  if (phase !== "ready") return <BootLoader />;
  return <>{children}</>;
}
