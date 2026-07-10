import type { ServerSummary } from "@tavern/shared";
import { create } from "zustand";
import type { WsStatus } from "@/lib/wsClient";

// Global server catalog + per-server connection state (§9.9 selectors). connState mirrors each
// wsClient's status; the wsClient is the sole writer (via setConnState).
interface ServersState {
  servers: ServerSummary[];
  activeServerId: string | null;
  connState: Record<string, WsStatus>;
  setServers: (servers: ServerSummary[]) => void;
  setActiveServer: (serverId: string | null) => void;
  setConnState: (serverId: string, state: WsStatus) => void;
}

export const useServersStore = create<ServersState>((set) => ({
  servers: [],
  activeServerId: null,
  connState: {},
  setServers: (servers) => set({ servers }),
  setActiveServer: (activeServerId) => set({ activeServerId }),
  setConnState: (serverId, state) =>
    set((s) => ({ connState: { ...s.connState, [serverId]: state } })),
}));
