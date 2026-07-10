import type { ServerSummary } from "@tavern/shared";
import { create } from "zustand";
import type { WsStatus } from "@/lib/wsClient";
import { roomStore } from "@/stores/room";

// Global server catalog + per-server connection state (§9.9 selectors). connState mirrors each
// wsClient's status; the wsClient is the sole writer (via setConnState).
interface ServersState {
  servers: ServerSummary[];
  activeServerId: string | null;
  connState: Record<string, WsStatus>;
  setServers: (servers: ServerSummary[]) => void;
  setActiveServer: (serverId: string | null) => void;
  setConnState: (serverId: string, state: WsStatus) => void;
  // FR-12 live rename: the wsClient routes an App-A `server.updated` frame here. Updates BOTH the
  // header dropdown list (this store's `servers`) AND the active room's `serverMeta` (via the room
  // store's own reducer) so every member sees the new name live.
  applyServerUpdated: (serverId: string, nickname: string) => void;
}

export const useServersStore = create<ServersState>((set) => ({
  servers: [],
  activeServerId: null,
  connState: {},
  setServers: (servers) => set({ servers }),
  setActiveServer: (activeServerId) => set({ activeServerId }),
  setConnState: (serverId, state) =>
    set((s) => ({ connState: { ...s.connState, [serverId]: state } })),
  applyServerUpdated: (serverId, nickname) => {
    set((s) => ({
      servers: s.servers.map((srv) => (srv.id === serverId ? { ...srv, nickname } : srv)),
    }));
    roomStore(serverId).getState().apply({ t: "server.updated", nickname, at: Date.now() });
  },
}));
