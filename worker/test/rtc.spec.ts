import { SELF, env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerRoom } from '../src/index';
import { pulledBitrateKbps } from '../src/lib/bitrate';

const BASE = 'https://tavern.test';

// ---- SFU mock: intercept the DO's globalThis.fetch to rtc.live.cloudflare.com,
// capture requests, return canned responses (§1: mock, replay recorded shapes).
const realFetch = globalThis.fetch;
let sfuCalls: Array<{ url: string; method: string; body: any; auth: string | null }> = [];
let sessSeq = 0;
beforeEach(() => {
  sfuCalls = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('rtc.live.cloudflare.com')) {
      const body = init?.body ? JSON.parse(init.body) : null;
      sfuCalls.push({ url, method: init?.method ?? 'GET', body, auth: new Headers(init?.headers).get('authorization') });
      let resp: any = {};
      if (url.endsWith('/sessions/new')) resp = { sessionId: `SFU-SESS-${++sessSeq}` };
      else if (url.endsWith('/tracks/new'))
        resp = {
          requiresImmediateRenegotiation: false,
          sessionDescription: { type: 'answer', sdp: 'v=0 mock' },
          tracks: (body?.tracks ?? []).map((t: any) => ({ trackName: t.trackName, mid: '0' })),
        };
      return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---- helpers -------------------------------------------------------------
const jpost = (path: string, body: unknown, token?: string) =>
  SELF.fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const rtc = (op: string, body: unknown, token: string) => jpost(`/api/rtc/${op}`, body, token);

async function newUser() {
  const nickname = 'u' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const b = await (await jpost('/api/register', { nickname, password: 'hunter2pw', repeat: 'hunter2pw' })).json<any>();
  return { token: b.token as string, userId: b.userId as string };
}
const makeServer = async (t: string) =>
  (await (await jpost('/api/servers', { name: 's' + crypto.randomUUID().slice(0, 6) }, t)).json<any>()).id as string;
const makeVoice = async (t: string, serverId: string) =>
  (await (await jpost(`/api/servers/${serverId}/channels`, { name: 'v' + crypto.randomUUID().slice(0, 6), kind: 'voice' }, t)).json<any>()).id as string;
const stubFor = (serverId: string) => env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));

class Client {
  msgs: any[] = [];
  constructor(private ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', (e: MessageEvent) => {
      this.msgs.push(JSON.parse(e.data as string));
    });
  }
  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  close() {
    this.ws.close();
  }
  async waitFor(pred: (m: any) => boolean, label = 'msg') {
    for (let i = 0; i < 400; i++) {
      const m = this.msgs.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`waitFor ${label} timed out; got ${JSON.stringify(this.msgs)}`);
  }
}

async function connect(serverId: string, token: string) {
  const res = await SELF.fetch(`${BASE}/api/servers/${serverId}/ws?token=${token}`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  return new Client(res.webSocket!);
}

// Bring a user fully into voice: WS + voice.join + SFU session established.
async function joinVoice(serverId: string, channelId: string, u: { token: string; userId: string }) {
  const c = await connect(serverId, u.token);
  await c.waitFor((m) => m.t === 'hello.ok');
  c.send({ v: 1, t: 'voice.join', channelId });
  await c.waitFor((m) => m.t === 'presence' && m.userId === u.userId && m.state === 'voice');
  expect((await rtc('session', { channelId }, u.token)).status).toBe(200);
  return c;
}

const publish = (token: string, channelId: string, o: any) =>
  rtc(
    'publish',
    {
      channelId,
      trackName: o.trackName,
      kind: o.kind,
      width: o.width ?? 0,
      height: o.height ?? 0,
      fps: o.fps ?? 0,
      simulcast: o.simulcast ?? false,
      sfu: { sessionDescription: { type: 'offer', sdp: 'v=0 mock' }, tracks: [{ location: 'local', mid: '0', trackName: o.trackName }] },
    },
    token,
  );

const readEst = async (serverId: string, month: string) => {
  const r = await env.DB.prepare('SELECT est_gb FROM budget_usage WHERE server_id = ? AND month = ?')
    .bind(serverId, month)
    .first<{ est_gb: number }>();
  return r?.est_gb ?? 0;
};
const monthOf = (ts: number) => new Date(ts).toISOString().slice(0, 7);

// ==========================================================================

describe('rtc: authorization + proxy', () => {
  it('not in voice → 403', async () => {
    const owner = await newUser();
    const serverId = await makeServer(owner.token);
    const voice = await makeVoice(owner.token, serverId);
    await connect(serverId, owner.token); // online but NOT voice.joined
    const res = await rtc('session', { channelId: voice }, owner.token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'not_in_voice' });
  });

  it('session establishes SFU session; secret is not in the response', async () => {
    const owner = await newUser();
    const serverId = await makeServer(owner.token);
    const voice = await makeVoice(owner.token, serverId);
    const c = await connect(serverId, owner.token);
    await c.waitFor((m) => m.t === 'hello.ok');
    c.send({ v: 1, t: 'voice.join', channelId: voice });
    await c.waitFor((m) => m.t === 'presence' && m.userId === owner.userId && m.state === 'voice');

    const res = await rtc('session', { channelId: voice }, owner.token);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).sfu.sessionId).toMatch(/^SFU-SESS-/);
    expect(text).not.toContain(env.CF_APP_SECRET);
  });
});

describe('rtc: publish + registry + share cap', () => {
  it('publish registers a track and broadcasts tracks with width/height/fps', async () => {
    const owner = await newUser();
    const serverId = await makeServer(owner.token);
    const voice = await makeVoice(owner.token, serverId);
    const c = await joinVoice(serverId, voice, owner);

    const res = await publish(owner.token, voice, { trackName: 'screen-1', kind: 'screen', width: 1920, height: 1080, fps: 30, simulcast: true });
    expect(res.status).toBe(200);
    const tracks = await c.waitFor((m) => m.t === 'tracks' && m.ownerId === owner.userId);
    expect(tracks.tracks).toContainEqual(
      expect.objectContaining({ trackName: 'screen-1', kind: 'screen', width: 1920, height: 1080, fps: 30, simulcast: true }),
    );
  });

  it('4th concurrent screen publish → 409 share_limit', async () => {
    const owner = await newUser();
    const serverId = await makeServer(owner.token);
    const voice = await makeVoice(owner.token, serverId);
    await joinVoice(serverId, voice, owner);
    for (let i = 1; i <= 3; i++)
      expect((await publish(owner.token, voice, { trackName: `s${i}`, kind: 'screen', width: 1280, height: 720, fps: 30 })).status).toBe(200);
    const res = await publish(owner.token, voice, { trackName: 's4', kind: 'screen', width: 1280, height: 720, fps: 30 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'share_limit' });
  });

  it('unpublish deregisters and broadcasts empty tracks', async () => {
    const owner = await newUser();
    const serverId = await makeServer(owner.token);
    const voice = await makeVoice(owner.token, serverId);
    const c = await joinVoice(serverId, voice, owner);
    await publish(owner.token, voice, { trackName: 'cam', kind: 'webcam', width: 1280, height: 720, fps: 30, simulcast: true });
    await c.waitFor((m) => m.t === 'tracks' && m.tracks.length === 1);
    expect((await rtc('unpublish', { channelId: voice, trackName: 'cam' }, owner.token)).status).toBe(200);
    await c.waitFor((m) => m.t === 'tracks' && m.ownerId === owner.userId && m.tracks.length === 0);
    // The SFU CloseTracksRequest closes by transceiver mid with force (no renegotiation) —
    // the {trackName} shape 400s against the real SFU (found live at S5.2).
    const close = sfuCalls.find((x) => x.url.endsWith('/tracks/close'));
    expect(close?.method).toBe('PUT');
    expect(close?.body).toEqual({ tracks: [{ mid: '0' }], force: true });
  });

  // §1: on voice.leave / WS close (and the stale sweep, same helper) the user's track
  // registry is cleared and an empty `tracks` roster is broadcast. Found live at S5.2:
  // a crashed sharer left its stale tracks in the next hello.ok.
  it('voice.leave clears the track registry and broadcasts empty tracks', async () => {
    const owner = await newUser();
    const watcher = await newUser();
    const serverId = await makeServer(owner.token);
    await jpost('/api/servers/join', { serverId }, watcher.token);
    const voice = await makeVoice(owner.token, serverId);
    const c = await joinVoice(serverId, voice, owner);
    const w = await connect(serverId, watcher.token);
    await publish(owner.token, voice, { trackName: 'scr', kind: 'screen', width: 1280, height: 720, fps: 30 });
    await w.waitFor((m) => m.t === 'tracks' && m.ownerId === owner.userId && m.tracks.length === 1);
    c.send({ t: 'voice.leave' });
    await w.waitFor((m) => m.t === 'tracks' && m.ownerId === owner.userId && m.tracks.length === 0);
  });

  it('WS close clears the track registry and broadcasts empty tracks', async () => {
    const owner = await newUser();
    const watcher = await newUser();
    const serverId = await makeServer(owner.token);
    await jpost('/api/servers/join', { serverId }, watcher.token);
    const voice = await makeVoice(owner.token, serverId);
    const c = await joinVoice(serverId, voice, owner);
    const w = await connect(serverId, watcher.token);
    await publish(owner.token, voice, { trackName: 'scr', kind: 'screen', width: 1280, height: 720, fps: 30 });
    await w.waitFor((m) => m.t === 'tracks' && m.ownerId === owner.userId && m.tracks.length === 1);
    c.close();
    await w.waitFor((m) => m.t === 'tracks' && m.ownerId === owner.userId && m.tracks.length === 0);
    // A reconnecting client must not see the stale track in hello.ok.
    const again = await connect(serverId, watcher.token);
    const hello = await again.waitFor((m) => m.t === 'hello.ok');
    expect(hello.tracks).toEqual([]);
  });
});

describe('rtc: subscribe', () => {
  async function ownerWithTrack(track: any) {
    const owner = await newUser();
    const sub = await newUser();
    const serverId = await makeServer(owner.token);
    await jpost('/api/servers/join', { serverId }, sub.token);
    const voice = await makeVoice(owner.token, serverId);
    await joinVoice(serverId, voice, owner);
    await joinVoice(serverId, voice, sub);
    await publish(owner.token, voice, track);
    return { owner, sub, serverId, voice };
  }

  it('resolves owner sessionId server-side (client never sends it)', async () => {
    const { owner, sub, voice } = await ownerWithTrack({ trackName: 'scr', kind: 'screen', width: 1920, height: 1080, fps: 30, simulcast: true });
    sfuCalls = [];
    const res = await rtc('subscribe', { channelId: voice, ownerId: owner.userId, trackName: 'scr', layer: 'h' }, sub.token);
    expect(res.status).toBe(200);
    const pull = sfuCalls.find((c) => c.method === 'POST' && c.url.endsWith('/tracks/new'));
    expect(pull!.body.tracks[0].sessionId).toMatch(/^SFU-SESS-/); // resolved owner session
    expect(pull!.body.tracks[0].simulcast.preferredRid).toBe('h');
  });

  it('single-encoding (simulcast:false) track ignores layer — no rid field sent', async () => {
    const { owner, sub, voice } = await ownerWithTrack({ trackName: 'cam', kind: 'webcam', width: 640, height: 360, fps: 30, simulcast: false });
    sfuCalls = [];
    const res = await rtc('subscribe', { channelId: voice, ownerId: owner.userId, trackName: 'cam', layer: 'h' }, sub.token);
    expect(res.status).toBe(200);
    const pull = sfuCalls.find((c) => c.url.endsWith('/tracks/new'))!;
    expect(pull.body.tracks[0].simulcast).toBeUndefined();
  });
});

describe('rtc: budget', () => {
  it('mic layer bitrate is 50 kbps (accrual rate)', () => {
    expect(pulledBitrateKbps({ kind: 'mic', width: 0, height: 0, fps: 0, simulcast: false }, 'h')).toBe(50);
  });

  it('hard level: video subscribe → 403 budget_exceeded, mic never blocked', async () => {
    const owner = await newUser();
    const sub = await newUser();
    const serverId = await makeServer(owner.token);
    await jpost('/api/servers/join', { serverId }, sub.token);
    const voice = await makeVoice(owner.token, serverId);

    const month = '2040-01';
    const ts = Date.parse(`${month}-15T00:00:00Z`);
    // Two seeded rows sum over the hard cap (950) → trip the level at flush.
    await env.DB.prepare('INSERT INTO budget_usage (month, server_id, est_gb) VALUES (?, ?, ?), (?, ?, ?)')
      .bind(month, serverId, 500, month, 'other-server', 460)
      .run();

    const stub = stubFor(serverId);
    await runInDurableObject(stub, (i: ServerRoom) => {
      i.nowMs = () => ts;
    });
    await joinVoice(serverId, voice, owner);
    await joinVoice(serverId, voice, sub);
    await publish(owner.token, voice, { trackName: 'scr', kind: 'screen', width: 1920, height: 1080, fps: 30, simulcast: true });
    await publish(owner.token, voice, { trackName: 'mic', kind: 'mic', simulcast: false });
    await runDurableObjectAlarm(stub); // flush → level=hard cached

    const vid = await rtc('subscribe', { channelId: voice, ownerId: owner.userId, trackName: 'scr', layer: 'h' }, sub.token);
    expect(vid.status).toBe(403);
    expect(await vid.json()).toEqual({ code: 'budget_exceeded' });

    const mic = await rtc('subscribe', { channelId: voice, ownerId: owner.userId, trackName: 'mic', layer: 'h' }, sub.token);
    expect(mic.status).toBe(200); // mic never blocked
  });

  it('accrual grows under injectable clock, flushes to D1, stops on unsubscribe', async () => {
    const owner = await newUser();
    const sub = await newUser();
    const serverId = await makeServer(owner.token);
    await jpost('/api/servers/join', { serverId }, sub.token);
    const voice = await makeVoice(owner.token, serverId);

    const t0 = Date.parse('2041-06-15T00:00:00Z');
    const month = monthOf(t0);
    const stub = stubFor(serverId);
    const setClock = (ts: number) => runInDurableObject(stub, (i: ServerRoom) => (i.nowMs = () => ts));

    await setClock(t0);
    await joinVoice(serverId, voice, owner);
    await joinVoice(serverId, voice, sub);
    await publish(owner.token, voice, { trackName: 'mic', kind: 'mic', simulcast: false });
    expect((await rtc('subscribe', { channelId: voice, ownerId: owner.userId, trackName: 'mic', layer: 'h' }, sub.token)).status).toBe(200);

    await setClock(t0 + 30_000);
    await runDurableObjectAlarm(stub);
    const a = await readEst(serverId, month);
    expect(a).toBeCloseTo((50 * 30_000) / 8e9, 12); // mic 50 kbps × 30 s

    await setClock(t0 + 60_000);
    await runDurableObjectAlarm(stub);
    const b = await readEst(serverId, month);
    expect(b).toBeGreaterThan(a); // grew

    await rtc('unsubscribe', { channelId: voice, ownerId: owner.userId, trackName: 'mic' }, sub.token);
    const close = sfuCalls.find((x) => x.url.endsWith('/tracks/close'));
    expect(close?.body).toEqual({ tracks: [{ mid: '0' }], force: true });
    await setClock(t0 + 90_000);
    await runDurableObjectAlarm(stub);
    const c = await readEst(serverId, month);
    expect(c).toBeCloseTo(b, 12); // stopped — no further growth
  });

  it('accrual stops on subscriber WS close', async () => {
    const owner = await newUser();
    const sub = await newUser();
    const serverId = await makeServer(owner.token);
    await jpost('/api/servers/join', { serverId }, sub.token);
    const voice = await makeVoice(owner.token, serverId);

    const t0 = Date.parse('2042-06-15T00:00:00Z');
    const month = monthOf(t0);
    const stub = stubFor(serverId);
    const setClock = (ts: number) => runInDurableObject(stub, (i: ServerRoom) => (i.nowMs = () => ts));

    await setClock(t0);
    const ownerC = await joinVoice(serverId, voice, owner);
    const subC = await joinVoice(serverId, voice, sub);
    await publish(owner.token, voice, { trackName: 'mic', kind: 'mic', simulcast: false });
    expect((await rtc('subscribe', { channelId: voice, ownerId: owner.userId, trackName: 'mic', layer: 'h' }, sub.token)).status).toBe(200);

    await setClock(t0 + 30_000);
    subC.close(); // finalizes accrual at t0+30s
    await ownerC.waitFor((m) => m.t === 'presence' && m.userId === sub.userId && m.state === 'offline');

    await setClock(t0 + 60_000);
    await runDurableObjectAlarm(stub);
    const first = await readEst(serverId, month);
    await setClock(t0 + 120_000);
    await runDurableObjectAlarm(stub);
    const second = await readEst(serverId, month);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeCloseTo(first, 12); // frozen after WS close
  });
});

describe('rtc: renegotiate + close + hello tracks', () => {
  it('renegotiate proxies to the SFU (200)', async () => {
    const owner = await newUser();
    const serverId = await makeServer(owner.token);
    const voice = await makeVoice(owner.token, serverId);
    await joinVoice(serverId, voice, owner);
    sfuCalls = [];
    const res = await rtc('renegotiate', { channelId: voice, sfu: { sessionDescription: { type: 'answer', sdp: 'v=0 mock' } } }, owner.token);
    expect(res.status).toBe(200);
    expect(sfuCalls.some((c) => c.method === 'PUT' && c.url.endsWith('/renegotiate'))).toBe(true);
  });

  it('close clears the user’s tracks and broadcasts empty', async () => {
    const owner = await newUser();
    const serverId = await makeServer(owner.token);
    const voice = await makeVoice(owner.token, serverId);
    const c = await joinVoice(serverId, voice, owner);
    await publish(owner.token, voice, { trackName: 'scr', kind: 'screen', width: 1280, height: 720, fps: 30 });
    await c.waitFor((m) => m.t === 'tracks' && m.tracks.length === 1);
    expect((await rtc('close', { channelId: voice }, owner.token)).status).toBe(200);
    // No session-close endpoint exists on the SFU (OpenAPI 2024-05-21) — must not be called.
    expect(sfuCalls.some((x) => x.url.includes('/close') && !x.url.includes('/tracks/close'))).toBe(false);
    await c.waitFor((m) => m.t === 'tracks' && m.ownerId === owner.userId && m.tracks.length === 0);
  });

  it('hello.ok includes existing published tracks for a late joiner', async () => {
    const owner = await newUser();
    const late = await newUser();
    const serverId = await makeServer(owner.token);
    await jpost('/api/servers/join', { serverId }, late.token);
    const voice = await makeVoice(owner.token, serverId);
    await joinVoice(serverId, voice, owner);
    await publish(owner.token, voice, { trackName: 'scr', kind: 'screen', width: 1920, height: 1080, fps: 30, simulcast: true });

    const lateC = await connect(serverId, late.token);
    const hello = await lateC.waitFor((m) => m.t === 'hello.ok');
    expect(hello.tracks).toContainEqual(expect.objectContaining({ ownerId: owner.userId, trackName: 'scr', kind: 'screen' }));
  });
});

describe('rtc: rate limit', () => {
  it('11th rtc call within one second → 429', async () => {
    const owner = await newUser();
    const serverId = await makeServer(owner.token);
    const voice = await makeVoice(owner.token, serverId);
    await joinVoice(serverId, voice, owner); // note: this already made 1 rtc call (session)
    await runInDurableObject(stubFor(serverId), (i: ServerRoom) => {
      i.nowMs = () => 9_000_000; // freeze the rate window
      (i as any).rtcRate = new Map(); // reset counter for a clean window
    });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await rtc('renegotiate', { channelId: voice, sfu: {} }, owner.token)).status);
    expect(codes.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
