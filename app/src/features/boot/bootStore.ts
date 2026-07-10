import { MeResponse } from "@tavern/shared";
import { create } from "zustand";
import { apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { closeAllRooms, connectRoom } from "@/lib/wsClient";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";

// FR-43 boot state machine: loading → unauthed | loadingMe → connectingActive → ready.
// Pinned rules: no token / 401 → unauthed; GET /api/me populates session + servers; a WS connects
// to ALL joined servers in parallel (A6) but `ready` fires after the ACTIVE server's `hello.ok`;
// zero joined servers → ready (BootGate then routes to /join).
export type BootPhase = "loading" | "unauthed" | "loadingMe" | "connectingActive" | "ready";

interface BootStoreState {
  phase: BootPhase;
  start: () => void;
  restart: () => void;
  reset: () => void;
}

// Guards against the machine running twice (React StrictMode double-invokes the mount effect).
let running = false;

type SetPhase = (partial: Pick<BootStoreState, "phase">) => void;

async function runMachine(set: SetPhase): Promise<void> {
  if (running) return;
  running = true;
  try {
    set({ phase: "loading" });
    useSessionStore.getState().setBooting();
    set({ phase: "loadingMe" });

    let me: MeResponse;
    try {
      me = await apiClient.get("/api/me", MeResponse);
    } catch {
      // No token / 401 (or any /me failure) → clear the stale token and drop to unauthed.
      await authTransport.clear();
      useSessionStore.getState().setUnauthed();
      set({ phase: "unauthed" });
      return;
    }

    useSessionStore.getState().setAuthed(me.user);
    useServersStore.getState().setServers(me.servers);

    const [active] = me.servers;
    if (!active) {
      // Zero joined servers → ready; BootGate routes to /join.
      useServersStore.getState().setActiveServer(null);
      set({ phase: "ready" });
      return;
    }

    useServersStore.getState().setActiveServer(active.id);
    set({ phase: "connectingActive" });

    // A6: open a socket to every joined server in parallel; ready waits only on the active one.
    for (const server of me.servers) connectRoom(server.id);
    const activeConn = connectRoom(active.id);
    await new Promise<void>((resolve) => {
      if (activeConn.status === "open") {
        resolve();
        return;
      }
      const off = activeConn.on("hello.ok", () => {
        off();
        resolve();
      });
    });

    set({ phase: "ready" });
  } finally {
    running = false;
  }
}

export const useBootStore = create<BootStoreState>((set, get) => ({
  phase: "loading",
  start: () => {
    if (get().phase === "loading") void runMachine(set);
  },
  restart: () => {
    running = false;
    set({ phase: "loading" });
    void runMachine(set);
  },
  reset: () => {
    running = false;
    closeAllRooms();
    useSessionStore.getState().setUnauthed();
    useServersStore.getState().setServers([]);
    useServersStore.getState().setActiveServer(null);
    set({ phase: "unauthed" });
  },
}));

// Frozen surface consumed by S5.1 (restart after login, reset after logout).
export interface BootStore {
  restart(): void;
  reset(): void;
}

export const bootStore: BootStore = {
  restart: () => {
    useBootStore.getState().restart();
  },
  reset: () => {
    useBootStore.getState().reset();
  },
};
