import { useEffect } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { useStore } from "zustand";
import { AppShell } from "@/features/shell/AppShell";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";

// Route /s/:serverId. Guards membership (an unknown/unjoined id redirects to /join), makes the server
// active, and renders the shell bound to that server's room store. FR-11: when the room store's `kicked`
// flag flips (S4.3 sets it on the App-A `kicked` frame), toast, drop the server, and — if it was active
// — return to /join.
export function ServerPage() {
  const { serverId } = useParams();
  const isMember = useServersStore(
    (s) => serverId !== undefined && s.servers.some((sv) => sv.id === serverId),
  );

  if (serverId === undefined || !isMember) {
    return <Navigate to="/join" replace />;
  }
  return <ServerShell serverId={serverId} />;
}

function ServerShell({ serverId }: { serverId: string }) {
  const navigate = useNavigate();
  const setActiveServer = useServersStore((s) => s.setActiveServer);
  const kicked = useStore(roomStore(serverId), (s) => s.kicked);

  useEffect(() => {
    setActiveServer(serverId);
  }, [serverId, setActiveServer]);

  useEffect(() => {
    if (!kicked) return;
    const store = useServersStore.getState();
    const server = store.servers.find((s) => s.id === serverId);
    toast(m.servers_kicked_toast({ server: server?.nickname ?? "" }));
    const wasActive = store.activeServerId === serverId;
    store.setServers(store.servers.filter((s) => s.id !== serverId));
    if (wasActive) {
      store.setActiveServer(null);
      navigate("/join");
    }
  }, [kicked, serverId, navigate]);

  return <AppShell serverId={serverId} />;
}
