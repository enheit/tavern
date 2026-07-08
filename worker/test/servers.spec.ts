import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import * as cryptoMod from '../src/lib/crypto';
import type { ServerRoom } from '../src/index';

const BASE = 'https://tavern.test';
const post = (path: string, body: unknown, token?: string) =>
  SELF.fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (path: string, token?: string) =>
  SELF.fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const rnd = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

async function newUser() {
  const nickname = 'u' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const res = await post('/api/register', { nickname, password: 'hunter2pw', repeat: 'hunter2pw' });
  const body = await res.json<any>();
  return { token: body.token as string, userId: body.userId as string, nickname };
}

async function createServer(token: string, extra: Record<string, unknown> = {}) {
  const res = await post('/api/servers', { name: 'srv-' + rnd(), ...extra }, token);
  return { res, body: res.status === 201 ? await res.json<any>() : null };
}

async function createChannel(token: string, serverId: string, extra: Record<string, unknown> = {}) {
  const res = await post(`/api/servers/${serverId}/channels`, { name: 'ch-' + rnd(), kind: 'text', ...extra }, token);
  return { res, body: res.status === 201 ? await res.json<any>() : null };
}

describe('servers: create + list + membership', () => {
  it('create → 201 {id,name}; creator is owner+member', async () => {
    const owner = await newUser();
    const { res, body } = await createServer(owner.token);
    expect(res.status).toBe(201);
    expect(body).toEqual({ id: expect.any(String), name: expect.any(String) });

    const list = await (await get('/api/servers', owner.token)).json<any>();
    expect(list).toContainEqual({ id: body.id, name: body.name, role: 'owner' });
  });

  it('GET /servers = memberships only (not other users’ servers)', async () => {
    const a = await newUser();
    const b = await newUser();
    const srvB = await createServer(b.token);
    const listA = await (await get('/api/servers', a.token)).json<any[]>();
    expect(listA.find((s) => s.id === srvB.body.id)).toBeUndefined();
  });

  it('join passwordless → 200, then appears in list as member', async () => {
    const owner = await newUser();
    const joiner = await newUser();
    const srv = await createServer(owner.token);
    const join = await post('/api/servers/join', { serverId: srv.body.id }, joiner.token);
    expect(join.status).toBe(200);
    const list = await (await get('/api/servers', joiner.token)).json<any>();
    expect(list).toContainEqual({ id: srv.body.id, name: srv.body.name, role: 'member' });
  });

  it('join wrong password → 403 wrong_password', async () => {
    const owner = await newUser();
    const joiner = await newUser();
    const srv = await createServer(owner.token, { password: 'server-secret' });
    const join = await post('/api/servers/join', { serverId: srv.body.id, password: 'nope' }, joiner.token);
    expect(join.status).toBe(403);
    expect(await join.json()).toEqual({ code: 'wrong_password' });
  });

  it('already-member re-join → 200 no-change (no password re-check)', async () => {
    const owner = await newUser();
    const srv = await createServer(owner.token, { password: 'server-secret' });
    // owner is already a member; re-join with NO password must still 200.
    const rejoin = await post('/api/servers/join', { serverId: srv.body.id }, owner.token);
    expect(rejoin.status).toBe(200);
    expect(await rejoin.json()).toEqual({ id: srv.body.id, name: srv.body.name });
  });

  it('nonexistent join is indistinguishable from wrong password (verify called once, same response)', async () => {
    const owner = await newUser();
    const joiner = await newUser();
    const srv = await createServer(owner.token, { password: 'server-secret' });

    const spy = vi.spyOn(cryptoMod, 'verifyPassword');

    spy.mockClear();
    const wrong = await post('/api/servers/join', { serverId: srv.body.id, password: 'bad' }, joiner.token);
    const wrongCalls = spy.mock.calls.length;
    const wrongBody = await wrong.json();

    spy.mockClear();
    const missing = await post('/api/servers/join', { serverId: crypto.randomUUID(), password: 'bad' }, joiner.token);
    const missingCalls = spy.mock.calls.length;
    const missingBody = await missing.json();

    spy.mockRestore();

    expect(wrong.status).toBe(403);
    expect(missing.status).toBe(wrong.status);
    expect(missingBody).toEqual(wrongBody);
    expect(wrongCalls).toBe(1);
    expect(missingCalls).toBe(1);
  });
});

describe('channels: create + list + unlock', () => {
  it('channel create is owner-only (owner 201, member 403)', async () => {
    const owner = await newUser();
    const member = await newUser();
    const srv = await createServer(owner.token);
    await post('/api/servers/join', { serverId: srv.body.id }, member.token);

    expect((await createChannel(owner.token, srv.body.id)).res.status).toBe(201);
    expect((await createChannel(member.token, srv.body.id)).res.status).toBe(403);
  });

  it('duplicate channel name in a server → 400', async () => {
    const owner = await newUser();
    const srv = await createServer(owner.token);
    const name = 'dup-' + rnd();
    expect((await createChannel(owner.token, srv.body.id, { name })).res.status).toBe(201);
    expect((await createChannel(owner.token, srv.body.id, { name })).res.status).toBe(400);
  });

  it('non-member channel list → 403', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const srv = await createServer(owner.token);
    expect((await get(`/api/servers/${srv.body.id}/channels`, outsider.token)).status).toBe(403);
  });

  it('channel list: ordering + unlocked semantics', async () => {
    const owner = await newUser();
    const srv = await createServer(owner.token);
    const open = await createChannel(owner.token, srv.body.id, { name: 'ch-a-' + rnd() });
    const locked = await createChannel(owner.token, srv.body.id, { name: 'ch-b-' + rnd(), kind: 'voice', password: 'chan-secret' });

    const list = await (await get(`/api/servers/${srv.body.id}/channels`, owner.token)).json<any[]>();
    const ids = list.map((c) => c.id);
    expect(ids.indexOf(open.body.id)).toBeLessThan(ids.indexOf(locked.body.id)); // created_at ASC
    expect(list.find((c) => c.id === open.body.id)).toMatchObject({ hasPassword: false, unlocked: true });
    expect(list.find((c) => c.id === locked.body.id)).toMatchObject({ hasPassword: true, unlocked: false });
  });

  it('unlock happy → 204 then channel reads unlocked:true', async () => {
    const owner = await newUser();
    const srv = await createServer(owner.token);
    const locked = await createChannel(owner.token, srv.body.id, { password: 'chan-secret' });
    const ok = await post(`/api/channels/${locked.body.id}/unlock`, { password: 'chan-secret' }, owner.token);
    expect(ok.status).toBe(204);
    const list = await (await get(`/api/servers/${srv.body.id}/channels`, owner.token)).json<any[]>();
    expect(list.find((c) => c.id === locked.body.id)).toMatchObject({ unlocked: true });
  });

  it('unlock wrong password → 403', async () => {
    const owner = await newUser();
    const srv = await createServer(owner.token);
    const locked = await createChannel(owner.token, srv.body.id, { password: 'chan-secret' });
    const bad = await post(`/api/channels/${locked.body.id}/unlock`, { password: 'wrong' }, owner.token);
    expect(bad.status).toBe(403);
  });

  it('password-less unlock → 204 no-op, no channel_access row', async () => {
    const owner = await newUser();
    const srv = await createServer(owner.token);
    const open = await createChannel(owner.token, srv.body.id);
    const res = await post(`/api/channels/${open.body.id}/unlock`, { password: 'whatever' }, owner.token);
    expect(res.status).toBe(204);
    const row = await env.DB.prepare('SELECT 1 FROM channel_access WHERE user_id = ? AND channel_id = ?')
      .bind(owner.userId, open.body.id)
      .first();
    expect(row).toBeNull();
  });

  it('unlock rate limit: 6th attempt in window → 429, resets after 60 s (injectable clock)', async () => {
    const owner = await newUser();
    const srv = await createServer(owner.token);
    const locked = await createChannel(owner.token, srv.body.id, { password: 'chan-secret' });
    const serverId: string = srv.body.id;

    const stub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
    const T = 5_000_000;
    await runInDurableObject(stub, (inst: ServerRoom) => {
      inst.nowMs = () => T;
    });

    const attempt = () => post(`/api/channels/${locked.body.id}/unlock`, { password: 'wrong' }, owner.token);
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(403); // allowed but wrong
    expect((await attempt()).status).toBe(429); // 6th → rate limited

    // Advance past the fixed 60 s window → counter resets → allowed again (wrong pw → 403).
    await runInDurableObject(stub, (inst: ServerRoom) => {
      inst.nowMs = () => T + 60_000;
    });
    expect((await attempt()).status).toBe(403);
  });
});
