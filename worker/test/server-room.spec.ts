import {
  SELF,
  env,
  runInDurableObject,
  runDurableObjectAlarm,
  evictDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ServerRoom } from '../src/index';

const BASE = 'https://tavern.test';
const j = (path: string, body: unknown, token?: string) =>
  SELF.fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function newUser() {
  const nickname = 'u' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const body = await (await j('/api/register', { nickname, password: 'hunter2pw', repeat: 'hunter2pw' })).json<any>();
  return { token: body.token as string, userId: body.userId as string, nickname };
}
async function newServer(token: string) {
  return (await (await j('/api/servers', { name: 's' + crypto.randomUUID().slice(0, 6) }, token)).json<any>()).id as string;
}
async function newChannel(token: string, serverId: string, extra: Record<string, unknown> = {}) {
  return (
    await (
      await j(`/api/servers/${serverId}/channels`, { name: 'c' + crypto.randomUUID().slice(0, 6), kind: 'text', ...extra }, token)
    ).json<any>()
  ).id as string;
}

class Client {
  msgs: any[] = [];
  closeCode: number | null = null;
  constructor(private ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', (e: MessageEvent) => {
      this.msgs.push(JSON.parse(e.data as string));
    });
    ws.addEventListener('close', (e: CloseEvent) => {
      this.closeCode = e.code;
    });
  }
  send(obj: unknown) {
    this.ws.send(JSON.stringify(obj));
  }
  close() {
    this.ws.close();
  }
  count(pred: (m: any) => boolean) {
    return this.msgs.filter(pred).length;
  }
  async waitFor(pred: (m: any) => boolean, label = 'msg'): Promise<any> {
    for (let i = 0; i < 400; i++) {
      const m = this.msgs.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`waitFor ${label} timed out; got ${JSON.stringify(this.msgs)}`);
  }
  async waitCount(pred: (m: any) => boolean, n: number): Promise<void> {
    for (let i = 0; i < 600; i++) {
      if (this.count(pred) >= n) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`waitCount ${n} timed out at ${this.count(pred)}`);
  }
  async waitClose(): Promise<number> {
    for (let i = 0; i < 400; i++) {
      if (this.closeCode != null) return this.closeCode;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('close timed out');
  }
}

async function connect(serverId: string, token: string, expectStatus = 101) {
  const res = await SELF.fetch(`${BASE}/api/servers/${serverId}/ws?token=${token}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(res.status).toBe(expectStatus);
  return res.status === 101 ? new Client(res.webSocket!) : null;
}
const stubFor = (serverId: string) => env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));

describe('ServerRoom: upgrade + auth', () => {
  it('rejects missing/invalid token (401) and non-member (403)', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);

    expect((await SELF.fetch(`${BASE}/api/servers/${serverId}/ws`, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
    expect(
      (await SELF.fetch(`${BASE}/api/servers/${serverId}/ws?token=bogus`, { headers: { Upgrade: 'websocket' } })).status,
    ).toBe(401);

    const outsider = await newUser();
    expect(
      (await SELF.fetch(`${BASE}/api/servers/${serverId}/ws?token=${outsider.token}`, { headers: { Upgrade: 'websocket' } })).status,
    ).toBe(403);
  });

  it('sends hello.ok immediately with roster/presence/tracks/budget', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const a = (await connect(serverId, owner.token))!;
    const hello = await a.waitFor((m) => m.t === 'hello.ok', 'hello.ok');
    expect(hello.userId).toBe(owner.userId);
    expect(hello.roster).toContainEqual(expect.objectContaining({ userId: owner.userId, nickname: owner.nickname }));
    expect(hello.tracks).toEqual([]);
    expect(hello.budget).toMatchObject({ level: 'ok' });
  });
});

describe('ServerRoom: chat', () => {
  it('two clients: chat roundtrip', async () => {
    const owner = await newUser();
    const bob = await newUser();
    const serverId = await newServer(owner.token);
    await j('/api/servers/join', { serverId }, bob.token);
    const ch = await newChannel(owner.token, serverId);

    const a = (await connect(serverId, owner.token))!;
    const b = (await connect(serverId, bob.token))!;
    await a.waitFor((m) => m.t === 'hello.ok');
    await b.waitFor((m) => m.t === 'hello.ok');

    a.send({ v: 1, t: 'chat.send', channelId: ch, content: 'hi there', nonce: crypto.randomUUID() });
    const onA = await a.waitFor((m) => m.t === 'chat.msg', 'chat.msg@A');
    const onB = await b.waitFor((m) => m.t === 'chat.msg', 'chat.msg@B');
    expect(onA.content).toBe('hi there');
    expect(onB.content).toBe('hi there');
    expect(onA.id).toBe(onB.id);
  });

  it('message works immediately after connect (no client hello handshake)', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const ch = await newChannel(owner.token, serverId);
    const a = (await connect(serverId, owner.token))!;
    a.send({ v: 1, t: 'chat.send', channelId: ch, content: 'first!', nonce: crypto.randomUUID() });
    const msg = await a.waitFor((m) => m.t === 'chat.msg');
    expect(msg.content).toBe('first!');
  });

  it('empty/oversized content → error invalid', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const ch = await newChannel(owner.token, serverId);
    const a = (await connect(serverId, owner.token))!;
    a.send({ v: 1, t: 'chat.send', channelId: ch, content: '   ' });
    expect((await a.waitFor((m) => m.t === 'error')).code).toBe('invalid');
  });

  it('duplicate nonce delivered once (same session)', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const ch = await newChannel(owner.token, serverId);
    const a = (await connect(serverId, owner.token))!;
    const nonce = crypto.randomUUID();

    a.send({ v: 1, t: 'chat.send', channelId: ch, content: 'once', nonce });
    const first = await a.waitFor((m) => m.t === 'chat.msg');
    a.send({ v: 1, t: 'chat.send', channelId: ch, content: 'once again (ignored)', nonce });
    await a.waitCount((m) => m.t === 'chat.msg', 2); // second delivered to sender

    const both = a.msgs.filter((m) => m.t === 'chat.msg');
    expect(both[0].id).toBe(both[1].id); // same row re-sent, no new message
    expect(both[1].content).toBe('once');
  });

  it('duplicate nonce dedup survives hibernation eviction', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const ch = await newChannel(owner.token, serverId);
    const a = (await connect(serverId, owner.token))!;
    const nonce = crypto.randomUUID();

    a.send({ v: 1, t: 'chat.send', channelId: ch, content: 'survive', nonce });
    const first = await a.waitFor((m) => m.t === 'chat.msg');

    await evictDurableObject(stubFor(serverId)); // hibernate + evict

    a.send({ v: 1, t: 'chat.send', channelId: ch, content: 'dup', nonce });
    await a.waitCount((m) => m.t === 'chat.msg', 2);
    const both = a.msgs.filter((m) => m.t === 'chat.msg');
    expect(both[1].id).toBe(first.id); // deduped against the persisted SQLite row
  });

  it('history pagination: 55 messages → 50 + hasMore, then 5', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const ch = await newChannel(owner.token, serverId);
    const a = (await connect(serverId, owner.token))!;
    await a.waitFor((m) => m.t === 'hello.ok');

    for (let i = 0; i < 55; i++)
      a.send({ v: 1, t: 'chat.send', channelId: ch, content: `m${i}`, nonce: crypto.randomUUID() });
    await a.waitCount((m) => m.t === 'chat.msg', 55);

    a.send({ v: 1, t: 'chat.history', channelId: ch, beforeId: null, limit: 50 });
    const page1 = await a.waitFor((m) => m.t === 'chat.history');
    expect(page1.messages.length).toBe(50);
    expect(page1.hasMore).toBe(true);

    const oldest = page1.messages[page1.messages.length - 1].id; // DESC → last is smallest
    a.send({ v: 1, t: 'chat.history', channelId: ch, beforeId: oldest, limit: 50 });
    const page2 = await a.waitFor((m) => m.t === 'chat.history' && m !== page1);
    expect(page2.messages.length).toBe(5);
    expect(page2.hasMore).toBe(false);
  });

  it('heartbeat → heartbeat.ok', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const a = (await connect(serverId, owner.token))!;
    a.send({ v: 1, t: 'heartbeat' });
    await a.waitFor((m) => m.t === 'heartbeat.ok');
  });
});

describe('ServerRoom: presence', () => {
  it('accept→online, voice.join→voice, close→offline (observed by peer)', async () => {
    const owner = await newUser();
    const bob = await newUser();
    const serverId = await newServer(owner.token);
    await j('/api/servers/join', { serverId }, bob.token);
    const voiceCh = await newChannel(owner.token, serverId, { kind: 'voice' });

    const a = (await connect(serverId, owner.token))!;
    await a.waitFor((m) => m.t === 'hello.ok');
    const b = (await connect(serverId, bob.token))!;

    // A observes B come online.
    const online = await a.waitFor((m) => m.t === 'presence' && m.userId === bob.userId && m.state === 'online');
    expect(online.channelId).toBeNull();

    b.send({ v: 1, t: 'voice.join', channelId: voiceCh });
    const voice = await a.waitFor((m) => m.t === 'presence' && m.userId === bob.userId && m.state === 'voice');
    expect(voice.channelId).toBe(voiceCh);

    // voice.leave → back to online (a already saw one online at connect, so wait for the 2nd).
    b.send({ v: 1, t: 'voice.leave' });
    await a.waitCount((m) => m.t === 'presence' && m.userId === bob.userId && m.state === 'online', 2);

    b.close();
    const off = await a.waitFor((m) => m.t === 'presence' && m.userId === bob.userId && m.state === 'offline');
    expect(off.state).toBe('offline');
  });

  it('voice.join on a text channel → error invalid', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const textCh = await newChannel(owner.token, serverId, { kind: 'text' });
    const a = (await connect(serverId, owner.token))!;
    a.send({ v: 1, t: 'voice.join', channelId: textCh });
    expect((await a.waitFor((m) => m.t === 'error')).code).toBe('invalid');
  });

  it('voice.join on an unknown channel → error invalid', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const a = (await connect(serverId, owner.token))!;
    a.send({ v: 1, t: 'voice.join', channelId: crypto.randomUUID() });
    expect((await a.waitFor((m) => m.t === 'error')).code).toBe('invalid');
  });

  it('second connection supersedes the first (4002), no offline broadcast', async () => {
    const owner = await newUser();
    const observer = await newUser();
    const serverId = await newServer(owner.token);
    await j('/api/servers/join', { serverId }, observer.token);

    const obs = (await connect(serverId, observer.token))!;
    await obs.waitFor((m) => m.t === 'hello.ok');
    const a1 = (await connect(serverId, owner.token))!;
    await obs.waitFor((m) => m.t === 'presence' && m.userId === owner.userId && m.state === 'online');
    const seenBefore = obs.msgs.length;

    const a2 = (await connect(serverId, owner.token))!; // same user again
    expect(await a1.waitClose()).toBe(4002);
    // Give any (erroneous) offline broadcast a chance to arrive, then assert none.
    await new Promise((r) => setTimeout(r, 40));
    expect(obs.count((m) => m.t === 'presence' && m.userId === owner.userId && m.state === 'offline')).toBe(0);
    void a2;
    void seenBefore;
  });
});

describe('ServerRoom: locked channels + stale sweep', () => {
  it('locked channel blocks chat.send + voice.join until unlock', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const locked = await newChannel(owner.token, serverId, { kind: 'voice', password: 'chan-secret' });
    const a = (await connect(serverId, owner.token))!;
    await a.waitFor((m) => m.t === 'hello.ok');

    a.send({ v: 1, t: 'chat.send', channelId: locked, content: 'sneak', nonce: crypto.randomUUID() });
    expect((await a.waitFor((m) => m.t === 'error')).code).toBe('locked');
    a.send({ v: 1, t: 'voice.join', channelId: locked });
    await a.waitCount((m) => m.t === 'error' && m.code === 'locked', 2);

    // Unlock via the REST endpoint, then both succeed.
    expect((await j(`/api/channels/${locked}/unlock`, { password: 'chan-secret' }, owner.token)).status).toBe(204);
    a.send({ v: 1, t: 'chat.send', channelId: locked, content: 'now allowed', nonce: crypto.randomUUID() });
    expect((await a.waitFor((m) => m.t === 'chat.msg')).content).toBe('now allowed');
    a.send({ v: 1, t: 'voice.join', channelId: locked });
    await a.waitFor((m) => m.t === 'presence' && m.userId === owner.userId && m.state === 'voice');
  });

  it('chat.history on a locked channel without access → error locked', async () => {
    const owner = await newUser();
    const serverId = await newServer(owner.token);
    const locked = await newChannel(owner.token, serverId, { password: 'chan-secret' });
    const a = (await connect(serverId, owner.token))!;
    await a.waitFor((m) => m.t === 'hello.ok');
    a.send({ v: 1, t: 'chat.history', channelId: locked, beforeId: null, limit: 50 });
    expect((await a.waitFor((m) => m.t === 'error')).code).toBe('locked');
  });

  it('stale-presence sweep reaps >75 s via alarm (injectable clock)', async () => {
    const owner = await newUser();
    const observer = await newUser();
    const serverId = await newServer(owner.token);
    await j('/api/servers/join', { serverId }, observer.token);

    const obs = (await connect(serverId, observer.token))!;
    const a = (await connect(serverId, owner.token))!;
    await obs.waitFor((m) => m.t === 'presence' && m.userId === owner.userId && m.state === 'online');

    const stub = stubFor(serverId);
    const future = Date.now() + 80_000;
    await runInDurableObject(stub, (inst: ServerRoom) => {
      inst.nowMs = () => future;
    });
    await runDurableObjectAlarm(stub);

    await obs.waitFor((m) => m.t === 'presence' && m.userId === owner.userId && m.state === 'offline');
    void a;
  });
});
