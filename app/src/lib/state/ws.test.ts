import { afterEach, describe, expect, test, vi } from 'vitest';
import { WsClient, backoffMs, applyServerFrame, wsUrl, type Socket } from './ws.svelte';
import { ChatStore, chat } from './chat.svelte';
import { servers } from './servers.svelte';
import type { ServerFrame } from '../protocol/ServerFrame';
import type { ChatMsg } from '../protocol/ChatMsg';

function msg(id: number, channelId = 'c1'): ChatMsg {
  return { id, channelId, userId: 'u1', content: `m${id}`, nonce: null, createdAt: id };
}

const hello: ServerFrame = {
  t: 'hello.ok',
  userId: 'u1',
  roster: [],
  presence: [],
  tracks: [],
  budget: { level: 'ok', estMbps: 0, monthGb: 0 },
};

// A scripted mock WS "server": faithful chat.history paging (DESC, limit+1 →
// hasMore), driving a fresh socket per connect.
class MockServer {
  log: ChatMsg[] = [];
  sockets: MockSocket[] = [];
  replyHeartbeat = false;

  factory = (_url: string): Socket => {
    const s = new MockSocket(this);
    this.sockets.push(s);
    setTimeout(() => s.boot(), 0); // defer so the client can attach handlers first
    return s;
  };

  push(m: ChatMsg): void {
    this.log.push(m);
    for (const s of this.sockets) if (s.alive) s.recv({ v: 1, t: 'chat.msg', ...m });
  }

  history(before: number | null, limit: number): { messages: ChatMsg[]; hasMore: boolean } {
    const desc = [...this.log].reverse().filter((m) => before == null || m.id < before);
    const page = desc.slice(0, limit + 1);
    return { messages: page.slice(0, limit), hasMore: page.length > limit };
  }
}

class MockSocket implements Socket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  alive = false;
  constructor(private server: MockServer) {}
  boot(): void {
    this.alive = true;
    this.onopen?.();
    this.recv(hello);
  }
  recv(frame: unknown): void {
    if (this.alive) this.onmessage?.({ data: JSON.stringify(frame) });
  }
  send(data: string): void {
    const f = JSON.parse(data);
    if (f.t === 'heartbeat') {
      if (this.server.replyHeartbeat) this.recv({ v: 1, t: 'heartbeat.ok' });
      return;
    }
    if (f.t === 'chat.history') {
      const { messages, hasMore } = this.server.history(f.beforeId, f.limit);
      this.recv({ v: 1, t: 'chat.history', channelId: f.channelId, messages, hasMore });
    }
  }
  close(): void {
    if (!this.alive) return;
    this.alive = false;
    this.onclose?.();
  }
}

function toStore(store: ChatStore, f: ServerFrame): void {
  if (f.t === 'chat.msg') {
    store.add({ id: f.id, channelId: f.channelId, userId: f.userId, content: f.content, nonce: f.nonce, createdAt: f.createdAt });
  } else if (f.t === 'chat.history') {
    store.merge(f.channelId, f.messages);
  }
}

afterEach(() => vi.useRealTimers());

test('backoffMs is exactly 1,2,4,8,16,30,30… seconds', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([
    1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
  ]);
});

test('wsUrl derives ws/wss from the api base', () => {
  expect(wsUrl('http://localhost:8787', 's1', 'tok')).toBe(
    'ws://localhost:8787/api/servers/s1/ws?token=tok',
  );
  expect(wsUrl('https://api.example.com', 's1', 'a b')).toBe(
    'wss://api.example.com/api/servers/s1/ws?token=a%20b',
  );
});

test('drop→reconnect gap-fills missed messages with no loss or dupes', async () => {
  vi.useFakeTimers();
  const store = new ChatStore();
  const srv = new MockServer();
  const client = new WsClient('ws://x', { connect: srv.factory, onFrame: (f) => toStore(store, f) });
  client.activeChannelId = 'c1';

  client.open();
  await vi.advanceTimersByTimeAsync(0); // open + hello.ok → resume (empty log)
  expect(client.state).toBe('open');

  for (const id of [1, 2, 3]) srv.push(msg(id));
  await vi.advanceTimersByTimeAsync(0);
  expect(store.messages('c1').map((m) => m.id)).toEqual([1, 2, 3]);

  // Server-initiated drop → client backs off.
  srv.sockets.at(-1)!.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.state).toBe('backoff');

  // Messages arrive while the client is offline.
  for (const id of [4, 5, 6]) srv.log.push(msg(id));

  // Backoff fires (1 s) → reconnect → hello.ok → resume gap-fill.
  await vi.advanceTimersByTimeAsync(backoffMs(0) + 50);
  await vi.advanceTimersByTimeAsync(0);
  expect(client.state).toBe('open');
  expect(store.messages('c1').map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6]);

  client.close();
});

test('watchdog force-closes after 45 s of server silence; a message resets it', async () => {
  vi.useFakeTimers();
  const srv = new MockServer(); // silent to heartbeats
  const client = new WsClient('ws://x', { connect: srv.factory });

  client.open();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.state).toBe('open');

  await vi.advanceTimersByTimeAsync(44_000);
  srv.push(msg(1)); // resets the watchdog
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(44_000); // < 45 s since the reset
  expect(client.state).toBe('open');

  await vi.advanceTimersByTimeAsync(1_000); // now 45 s of silence
  expect(client.state).toBe('backoff');

  client.close();
});

test('reconnect delays grow 1,2,4,8 s across repeated connect failures', async () => {
  vi.useFakeTimers(); // also fakes Date.now → virtual connect timestamps
  const times: number[] = [];
  let last: Socket | null = null;
  const factory = (): Socket => {
    times.push(Date.now());
    last = { onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
    return last;
  };
  const client = new WsClient('ws://x', { connect: factory });

  client.open(); // attempt #1 at t=0
  for (const delay of [1000, 2000, 4000, 8000]) {
    last!.onclose?.(); // fail (no hello) → schedule the next backoff
    await vi.advanceTimersByTimeAsync(delay);
  }
  client.close();

  // Attempts land at 0, 1000, 3000, 7000, 15000ms → deltas 1,2,4,8 s.
  const deltas = times.slice(1).map((t, i) => t - times[i]);
  expect(deltas).toEqual([1000, 2000, 4000, 8000]);
});

describe('applyServerFrame routing', () => {
  test('routes hello.ok / presence / profile / chat into app state', () => {
    chat.reset();
    applyServerFrame('s1', hello);
    applyServerFrame('s1', {
      t: 'hello.ok',
      userId: 'u1',
      roster: [{ userId: 'u1', nickname: 'A', color: '#fff', avatarKey: null }],
      presence: [{ userId: 'u1', state: 'online', channelId: null }],
      tracks: [],
      budget: { level: 'ok', estMbps: 0, monthGb: 0 },
    });
    expect(servers.rosterByServer['s1']?.[0].nickname).toBe('A');
    expect(servers.presenceByServer['s1']?.['u1'].state).toBe('online');

    applyServerFrame('s1', { t: 'presence', userId: 'u2', state: 'voice', channelId: 'c1' });
    expect(servers.presenceByServer['s1']['u2'].state).toBe('voice');

    applyServerFrame('s1', { t: 'profile', userId: 'u1', nickname: 'A2', color: '#000', avatarKey: 'k' });
    expect(servers.rosterByServer['s1'][0].nickname).toBe('A2');

    applyServerFrame('s1', { t: 'chat.msg', id: 2, channelId: 'c1', userId: 'u1', content: 'hi', nonce: null, createdAt: 2 });
    applyServerFrame('s1', {
      t: 'chat.history',
      channelId: 'c1',
      messages: [{ id: 1, channelId: 'c1', userId: 'u1', content: 'older', nonce: null, createdAt: 1 }],
      hasMore: false,
    });
    expect(chat.messages('c1').map((m) => m.id)).toEqual([1, 2]);
  });
});
