import type { ClientMessage, ServerMessage } from "@tavern/shared";
import { LIMITS, serverMessageSchema, WsTicketResponse } from "@tavern/shared";
import { roomStore } from "@/stores/room";
import { useMediaStore } from "@/stores/media";
import { useServersStore } from "@/stores/servers";
import { ApiError, apiClient } from "./apiClient";
import { clearMediaOwner, shouldResetMediaAfterNavigation } from "./mediaOwnership";

// §6.2 / A4 / A6 — one WS per joined server. Connect flow: POST /api/ws-ticket → open the socket
// with the ticket → send `hello` → expect `hello.ok` within helloTimeoutMs. Reconnect with
// jittered exponential backoff, refetching a ticket every attempt; `hello.ok` replaces room state.
export type WsStatus = "connecting" | "open" | "reconnecting" | "closed";

export class WsNotOpenError extends Error {
  constructor() {
    super("ws_not_open");
    this.name = "WsNotOpenError";
  }
}

export interface WsConnection {
  status: WsStatus;
  send(msg: ClientMessage): void; // throws WsNotOpenError when status !== 'open'
  on<T extends ServerMessage["t"]>(
    t: T,
    cb: (m: Extract<ServerMessage, { t: T }>) => void,
  ): () => void;
  close(): void;
}

// Same env var the apiClient uses; http→ws / https→wss.
const wsBase: string = (import.meta.env.VITE_API_URL ?? location.origin).replace(/^http/, "ws");

function backoffDelay(attempt: number, capMs: number): number {
  const base = Math.min(1000 * 2 ** attempt, capMs);
  return base * (0.8 + Math.random() * 0.4); // ±20% jitter (§6.2)
}

function isFrame<T extends ServerMessage["t"]>(
  m: ServerMessage,
  t: T,
): m is Extract<ServerMessage, { t: T }> {
  return m.t === t;
}

class RoomConnection implements WsConnection {
  status: WsStatus = "connecting";
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closedByUser = false;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineListener: (() => void) | null = null;
  private readonly listeners = new Set<(m: ServerMessage) => void>();
  private readonly resetAbandonedMedia: boolean;

  constructor(private readonly serverId: string) {
    this.resetAbandonedMedia = shouldResetMediaAfterNavigation(serverId);
  }

  // Kicks off the first connect. Called by connectRoom AFTER the instance is cached, so the
  // synchronous store write inside openOnce (setStatus → setConnState) cannot cause a re-entrant
  // connectRoom to build a second connection for the same server.
  start(): void {
    void this.openOnce();
  }

  send(msg: ClientMessage): void {
    if (this.status !== "open") throw new WsNotOpenError();
    this.raw(msg);
  }

  on<T extends ServerMessage["t"]>(
    t: T,
    cb: (m: Extract<ServerMessage, { t: T }>) => void,
  ): () => void {
    const wrapper = (m: ServerMessage): void => {
      if (isFrame(m, t)) cb(m);
    };
    this.listeners.add(wrapper);
    return () => {
      this.listeners.delete(wrapper);
    };
  }

  close(): void {
    this.closedByUser = true;
    this.clearSocketTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearOnlineListener();
    this.ws?.close();
    this.setStatus("closed");
  }

  private setStatus(status: WsStatus): void {
    this.status = status;
    useServersStore.getState().setConnState(this.serverId, status);
  }

  private raw(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private async openOnce(): Promise<void> {
    if (this.closedByUser) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let ticket: string;
    try {
      const res = await apiClient.post("/api/ws-ticket", WsTicketResponse, {
        serverId: this.serverId,
      });
      ticket = res.ticket;
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        this.setStatus("closed");
        return;
      }
      // Ticket issuance failed (auth/network) — treat like a drop and back off.
      this.scheduleReconnect();
      return;
    }
    if (this.closedByUser) return;
    const ws = new WebSocket(`${wsBase}/api/servers/${this.serverId}/ws?ticket=${ticket}`);
    this.ws = ws;
    ws.addEventListener("open", () => this.onOpen());
    ws.addEventListener("message", (ev) => this.onMessage(ev));
    ws.addEventListener("close", () => this.onClose());
    ws.addEventListener("error", () => {
      // A `close` event always follows; reconnect is handled there.
    });
  }

  private onOpen(): void {
    const media = useMediaStore.getState();
    const mediaResume = media.inVoiceServerId === this.serverId && media.voiceStatus === "joined";
    this.raw({
      t: "hello",
      proto: 1,
      mediaResume,
      mediaReset: !mediaResume && this.resetAbandonedMedia,
    });
    this.helloTimer = setTimeout(() => {
      this.ws?.close();
    }, LIMITS.helloTimeoutMs);
  }

  private onMessage(ev: MessageEvent): void {
    let raw: unknown;
    try {
      raw = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      this.dropFrame("invalid_json");
      return;
    }
    const parsed = serverMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.dropFrame("bad_frame");
      return;
    }
    const msg = parsed.data;
    if (msg.t === "hello.ok") {
      if (this.helloTimer) {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
      }
      this.attempt = 0;
      this.setStatus("open");
      this.startPing();
      if (this.resetAbandonedMedia) clearMediaOwner(this.serverId);
    }
    if (msg.t === "server.updated") {
      // FR-12: route the live rename through the servers store so the header dropdown list AND the
      // room's serverMeta both update; applyServerUpdated re-applies the frame to this room store,
      // so it stands in for the blanket apply here (no double dispatch).
      useServersStore.getState().applyServerUpdated(this.serverId, msg.nickname);
    } else {
      roomStore(this.serverId).getState().apply(msg);
    }
    for (const listener of this.listeners) listener(msg);
  }

  private dropFrame(reason: string): void {
    // §9.5 exemption: an invalid frame is DROPPED (connection stays open) but not swallowed — it is
    // surfaced to the UI via the room store's lastProtocolError.
    console.error(`[ws] dropped invalid frame (${reason}) for server ${this.serverId}`);
    roomStore(this.serverId).getState().setProtocolError(reason);
  }

  private startPing(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      this.raw({ t: "ping" });
    }, LIMITS.pingIntervalMs);
  }

  private onClose(): void {
    this.clearSocketTimers();
    this.ws = null;
    if (this.closedByUser) {
      this.setStatus("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (!navigator.onLine) {
      this.setStatus("reconnecting");
      if (this.onlineListener === null) {
        this.onlineListener = () => {
          this.clearOnlineListener();
          void this.openOnce();
        };
        window.addEventListener("online", this.onlineListener, { once: true });
      }
      return;
    }
    const active = useServersStore.getState().activeServerId === this.serverId;
    const delay = backoffDelay(this.attempt, active ? LIMITS.reconnectCapMs : 5 * 60_000);
    this.attempt += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      void this.openOnce();
    }, delay);
  }

  wake(): void {
    if (this.closedByUser || this.status === "open" || this.status === "connecting") return;
    if (useServersStore.getState().activeServerId !== this.serverId) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearOnlineListener();
    void this.openOnce();
  }

  private clearOnlineListener(): void {
    if (this.onlineListener === null) return;
    window.removeEventListener("online", this.onlineListener);
    this.onlineListener = null;
  }

  private clearSocketTimers(): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

const rooms = new Map<string, RoomConnection>();

// A6 — one cached connection per server; features reuse the same socket. The instance is registered
// in `rooms` BEFORE it starts connecting, because the first connect synchronously writes the servers
// store (setStatus → setConnState) and a subscriber of that store (e.g. notifications) re-enters
// connectRoom during construction — so the cache must already hold this instance or an unbounded
// number of connections would be created for the same server.
export function connectRoom(serverId: string): WsConnection {
  const existing = rooms.get(serverId);
  if (existing) {
    existing.wake();
    return existing;
  }
  const conn = new RoomConnection(serverId);
  rooms.set(serverId, conn);
  conn.start();
  return conn;
}

export function closeAllRooms(): void {
  for (const conn of rooms.values()) conn.close();
  rooms.clear();
}
