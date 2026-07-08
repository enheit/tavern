import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

// S3.2 worker-project integration: a minimal protocol driver (`new WebSocket` in
// workerd, via SELF upgrade) that exercises connect → chat.send → drop →
// reconnect → resume gap-fill against the real ServerRoom. ws.svelte.ts itself is
// covered in the app project; this proves the SERVER supports the resume algorithm.

const BASE = 'https://tavern.test';
const post = (path: string, body: unknown, token?: string) =>
  SELF.fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function newUser() {
  const nickname = 'u' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const r = await (await post('/api/register', { nickname, password: 'hunter2pw', repeat: 'hunter2pw' })).json<any>();
  return { token: r.token as string, userId: r.userId as string };
}

/** ~30-line protocol driver: connects, reads frames, and runs resume gap-fill. */
class Driver {
  msgs: any[] = [];
  private ws!: WebSocket;
  constructor(
    private serverId: string,
    private token: string,
  ) {}
  async connect(): Promise<void> {
    const res = await SELF.fetch(`${BASE}/api/servers/${this.serverId}/ws?token=${this.token}`, {
      headers: { Upgrade: 'websocket' },
    });
    this.ws = res.webSocket!;
    this.ws.accept();
    this.ws.addEventListener('message', (e: MessageEvent) => {
      this.msgs.push(JSON.parse(e.data as string));
    });
    await this.waitFor((m) => m.t === 'hello.ok');
  }
  send(obj: unknown) {
    this.ws.send(JSON.stringify({ v: 1, ...(obj as object) }));
  }
  drop() {
    this.ws.close();
  }
  async waitFor(pred: (m: any) => boolean): Promise<any> {
    for (let i = 0; i < 400; i++) {
      const m = this.msgs.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout; got ${JSON.stringify(this.msgs)}`);
  }
  // §1 resume gap-fill: page chat.history back until oldest ≤ lastSeen or no more.
  async gapFill(channelId: string, lastSeen: number): Promise<number[]> {
    const got = new Set<number>();
    let beforeId: number | null = null;
    const before = this.msgs.filter((m) => m.t === 'chat.history').length;
    for (let page = 0; page < 4; page++) {
      this.send({ t: 'chat.history', channelId, beforeId, limit: 50 });
      await this.waitFor(() => this.msgs.filter((m) => m.t === 'chat.history').length > before + page);
      const frame = this.msgs.filter((m) => m.t === 'chat.history')[before + page];
      for (const m of frame.messages) got.add(m.id);
      const ids = frame.messages.map((m: any) => m.id);
      const oldest = ids.length ? Math.min(...ids) : null;
      if (oldest == null || oldest <= lastSeen || !frame.hasMore) break;
      beforeId = oldest;
    }
    return [...got].sort((a, b) => a - b);
  }
}

it('resumes with no loss: gap-fill fetches messages missed while disconnected', async () => {
  const owner = await newUser();
  const bob = await newUser();
  const serverId = (await (await post('/api/servers', { name: 's' + crypto.randomUUID().slice(0, 6) }, owner.token)).json<any>()).id;
  await post('/api/servers/join', { serverId }, bob.token);
  const channelId = (
    await (await post(`/api/servers/${serverId}/channels`, { name: 'general', kind: 'text' }, owner.token)).json<any>()
  ).id;

  const a = new Driver(serverId, owner.token);
  const b = new Driver(serverId, bob.token);
  await a.connect();
  await b.connect();

  // owner sends msg #1, sees the echo → lastSeen = its id.
  a.send({ t: 'chat.send', channelId, content: 'first', nonce: crypto.randomUUID() });
  const first = await a.waitFor((m) => m.t === 'chat.msg' && m.content === 'first');
  const lastSeen = first.id as number;

  // owner drops; bob sends two more while owner is offline.
  a.drop();
  b.send({ t: 'chat.send', channelId, content: 'second', nonce: crypto.randomUUID() });
  await b.waitFor((m) => m.t === 'chat.msg' && m.content === 'second');
  b.send({ t: 'chat.send', channelId, content: 'third', nonce: crypto.randomUUID() });
  await b.waitFor((m) => m.t === 'chat.msg' && m.content === 'third');

  // owner reconnects and gap-fills.
  const a2 = new Driver(serverId, owner.token);
  await a2.connect();
  const ids = await a2.gapFill(channelId, lastSeen);

  // No loss (missed 2), no dupes (contiguous, unique), includes the pre-drop msg.
  expect(ids.length).toBe(3);
  expect(ids).toContain(lastSeen);
  expect(new Set(ids).size).toBe(ids.length);
});
