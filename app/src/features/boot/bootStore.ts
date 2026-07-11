import { MeResponse } from "@tavern/shared";
import { create } from "zustand";
import { clearVoiceSession } from "@/features/voice/voiceSession";
import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { closeAllRooms, connectRoom } from "@/lib/wsClient";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";

// FR-43 boot state machine: loading → unauthed | loadingMe → connectingActive → ready | error.
// Pinned rules: no token / 401 → unauthed (any other /me failure → error, session kept); GET
// /api/me populates session + servers; a WS connects
// to ALL joined servers in parallel (A6) but `ready` fires after the ACTIVE server's `hello.ok`;
// zero joined servers → ready (BootGate then routes to /join). `connectingActive` is DEADLINED:
// if the active server's hello.ok hasn't arrived within CONNECT_DEADLINE_MS the machine lands in
// `error` (BootGate shows a retry screen) instead of spinning on the loader forever — the sockets
// keep their own reconnect loop running underneath, so a later retry can succeed instantly.
export type BootPhase =
  | "loading"
  | "unauthed"
  | "loadingMe"
  | "connectingActive"
  | "ready"
  | "error";

// Generous vs the 5s hello timeout: covers a ticket fetch + upgrade + hello plus a couple of
// client reconnect cycles before declaring the boot failed.
const CONNECT_DEADLINE_MS = 15_000;

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
    } catch (err) {
      // Only a real 401 means the session is gone — clear the stale token and drop to unauthed.
      // Anything else (network failure, 5xx, worker restarting mid-reload) is transient: keep the
      // token/cookie and land on `error` so BootError's retry can recover the still-valid session
      // instead of silently logging the user out.
      if (err instanceof ApiError && err.status === 401) {
        await authTransport.clear();
        useSessionStore.getState().setUnauthed();
        set({ phase: "unauthed" });
        return;
      }
      set({ phase: "error" });
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
    const opened = await new Promise<boolean>((resolve) => {
      if (activeConn.status === "open") {
        resolve(true);
        return;
      }
      let deadline: ReturnType<typeof setTimeout> | null = null;
      const off = activeConn.on("hello.ok", () => {
        off();
        if (deadline !== null) clearTimeout(deadline);
        resolve(true);
      });
      deadline = setTimeout(() => {
        off();
        resolve(false);
      }, CONNECT_DEADLINE_MS);
    });

    set({ phase: opened ? "ready" : "error" });
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
    // Logout kills the voice session snapshot — the next login in this tab may be a DIFFERENT
    // user, who must never inherit an auto-rejoin.
    clearVoiceSession();
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
