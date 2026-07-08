import type { ClientFrame } from '../protocol/ClientFrame';
import type { ServerFrame } from '../protocol/ServerFrame';
import type { ChatMsg } from '../protocol/ChatMsg';
import { chat } from './chat.svelte';
import { servers } from './servers.svelte';
import { voice } from './voice.svelte';

// One WebSocket per joined server (§1, ≤5). Protocol frames are `{v:1,t,...}`;
// the ts-rs ClientFrame/ServerFrame unions (S2.7) omit the transport `v`.

const HEARTBEAT_MS = 20_000; // §1: client heartbeat every 20 s
const WATCHDOG_MS = 45_000; // §1: no server msg for 45 s → force-close + backoff
const HISTORY_LIMIT = 50; // §1 resume: 50/page
const MAX_PAGES = 4; // §1 resume: cap 4 pages (200 msgs = in-memory cap)

// §1 backoff: exact 1,2,4,8,16,30,30… seconds, no jitter.
const BACKOFF_S = [1, 2, 4, 8, 16, 30];
export function backoffMs(attempt: number): number {
  return BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)] * 1000;
}

// Minimal socket surface — the real WebSocket satisfies it; tests supply a mock.
export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type WsState = 'connecting' | 'open' | 'backoff' | 'closed';

// Route a server frame into app state for one server. Frames carry no serverId
// (the socket is per-server), so the owning serverId is bound here.
export function applyServerFrame(serverId: string, frame: ServerFrame): void {
  switch (frame.t) {
    case 'hello.ok':
      servers.setRoster(serverId, frame.roster);
      servers.setPresence(serverId, frame.presence);
      voice.setHelloTracks(serverId, frame.tracks);
      break;
    case 'presence': {
      const p = { userId: frame.userId, state: frame.state, channelId: frame.channelId };
      servers.applyPresence(serverId, p);
      voice.notifyPresence(serverId, p); // resolves the §1 join waiter + re-applies gains
      break;
    }
    case 'profile':
      servers.applyProfile(serverId, {
        userId: frame.userId,
        nickname: frame.nickname,
        color: frame.color,
        avatarKey: frame.avatarKey,
      });
      break;
    case 'chat.msg':
      chat.add(frameToMsg(frame));
      break;
    case 'chat.history':
      chat.merge(frame.channelId, frame.messages);
      break;
    case 'tracks':
      voice.applyTracks(serverId, frame.ownerId, frame.tracks); // forwarded to the engine (§1)
      break;
    // budget → budget UI (S6.2); ignored by the shell.
  }
}

function frameToMsg(f: Extract<ServerFrame, { t: 'chat.msg' }>): ChatMsg {
  return {
    id: f.id,
    channelId: f.channelId,
    userId: f.userId,
    content: f.content,
    nonce: f.nonce,
    createdAt: f.createdAt,
  };
}

export class WsClient {
  state = $state<WsState>('closed');
  // Which channel to gap-fill on reconnect (the one being viewed).
  activeChannelId: string | null = null;

  private socket: Socket | null = null;
  private attempt = 0;
  private intentional = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private backoff: ReturnType<typeof setTimeout> | null = null;
  private lastSeenId = new Map<string, number>();
  private historyWaiter = new Map<string, (page: HistoryPage) => void>();

  constructor(
    private url: string,
    private opts: {
      connect: (url: string) => Socket;
      onFrame?: (f: ServerFrame) => void;
    },
  ) {}

  open(): void {
    this.intentional = false;
    this.connect();
  }

  send(frame: ClientFrame): void {
    if (this.state === 'open') this.socket?.send(JSON.stringify({ v: 1, ...frame }));
  }

  close(): void {
    this.intentional = true;
    this.clearTimers();
    this.detach(this.socket);
    try {
      this.socket?.close(1000, 'client');
    } catch {
      /* already closing */
    }
    this.socket = null;
    this.state = 'closed';
  }

  private connect(): void {
    this.state = 'connecting';
    const s = this.opts.connect(this.url);
    this.socket = s;
    s.onopen = () => this.armWatchdog();
    s.onmessage = (ev) => this.onMessage(ev.data);
    s.onclose = () => this.onClose();
    s.onerror = () => {
      /* an onclose follows */
    };
  }

  private onMessage(data: string): void {
    this.armWatchdog(); // any server message resets the 45 s watchdog
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }

    if (frame.t === 'chat.msg') this.bumpSeen(frame.channelId, frame.id);
    if (frame.t === 'chat.history') for (const m of frame.messages) this.bumpSeen(m.channelId, m.id);

    if (frame.t === 'hello.ok') {
      this.attempt = 0;
      this.state = 'open';
      this.startHeartbeat();
      this.opts.onFrame?.(frame);
      void this.resume();
      return;
    }
    if (frame.t === 'heartbeat.ok') return; // liveness only

    if (frame.t === 'chat.history') {
      this.opts.onFrame?.(frame);
      const w = this.historyWaiter.get(frame.channelId);
      if (w) {
        this.historyWaiter.delete(frame.channelId);
        w({ messages: frame.messages, hasMore: frame.hasMore });
      }
      return;
    }
    this.opts.onFrame?.(frame);
  }

  // §1 resume gap-fill: page chat.history back until we reach what we already had
  // (oldest ≤ lastSeen) or the server has no more, capped at 4 pages.
  private async resume(): Promise<void> {
    const channelId = this.activeChannelId;
    if (!channelId) return;
    const lastSeen = this.lastSeenId.get(channelId) ?? 0;
    let beforeId: number | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { messages, hasMore } = await this.requestHistory(channelId, beforeId);
      const oldest = messages.reduce<number | null>((min, m) => (min == null || m.id < min ? m.id : min), null);
      if (oldest == null || oldest <= lastSeen || !hasMore) break;
      beforeId = oldest;
    }
  }

  private requestHistory(channelId: string, beforeId: number | null): Promise<HistoryPage> {
    return new Promise((resolve) => {
      this.historyWaiter.set(channelId, resolve);
      this.send({ t: 'chat.history', channelId, beforeId, limit: HISTORY_LIMIT });
    });
  }

  private onClose(): void {
    this.clearTimers();
    this.socket = null;
    if (this.intentional) {
      this.state = 'closed';
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.state = 'backoff';
    const delay = backoffMs(this.attempt);
    this.attempt += 1;
    this.backoff = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.send({ t: 'heartbeat' }), HEARTBEAT_MS);
  }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.forceReconnect(), WATCHDOG_MS);
  }

  private forceReconnect(): void {
    const s = this.socket;
    this.detach(s);
    this.clearTimers();
    this.socket = null;
    try {
      s?.close(4000, 'watchdog');
    } catch {
      /* already closing */
    }
    this.scheduleReconnect();
  }

  private bumpSeen(channelId: string, id: number): void {
    if (id > (this.lastSeenId.get(channelId) ?? 0)) this.lastSeenId.set(channelId, id);
  }

  private detach(s: Socket | null): void {
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.backoff) clearTimeout(this.backoff);
    this.heartbeat = this.watchdog = this.backoff = null;
  }
}

interface HistoryPage {
  messages: ChatMsg[];
  hasMore: boolean;
}

// ---- pool: one client per joined server -----------------------------------

export function wsUrl(apiBase: string, serverId: string, token: string): string {
  const ws = apiBase.replace(/^http/, 'ws');
  return `${ws}/api/servers/${serverId}/ws?token=${encodeURIComponent(token)}`;
}

class WsPool {
  private clients = new Map<string, WsClient>();

  connect(apiBase: string, serverId: string, token: string): WsClient {
    let client = this.clients.get(serverId);
    if (client) return client;
    client = new WsClient(wsUrl(apiBase, serverId, token), {
      connect: (u) => new WebSocket(u) as unknown as Socket,
      onFrame: (f) => applyServerFrame(serverId, f),
    });
    this.clients.set(serverId, client);
    client.open();
    return client;
  }

  get(serverId: string): WsClient | undefined {
    return this.clients.get(serverId);
  }

  disconnect(serverId: string): void {
    this.clients.get(serverId)?.close();
    this.clients.delete(serverId);
  }
}

export const wsPool = new WsPool();

// Bind the voice store's WS seam to the pool (kept here to avoid an import cycle:
// voice.svelte.ts must not import this module). Tests override voice.sendFrame directly.
voice.sendFrame = (serverId, frame) => wsPool.get(serverId)?.send(frame);
