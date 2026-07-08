import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const BASE = 'https://tavern.test';
const j = (method: string, path: string, body: unknown, token?: string) =>
  SELF.fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function newUser() {
  const nickname = 'u' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const body = await (await j('POST', '/api/register', { nickname, password: 'hunter2pw', repeat: 'hunter2pw' })).json<any>();
  return { token: body.token as string, userId: body.userId as string, nickname };
}

describe('PATCH /me', () => {
  it('updates nickname → 200 profile', async () => {
    const u = await newUser();
    const next = 'renamed_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const res = await j('PATCH', '/api/me', { nickname: next }, u.token);
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toMatchObject({ userId: u.userId, nickname: next, color: '#8a8f98' });
  });

  it('updates color → 200 profile', async () => {
    const u = await newUser();
    const res = await j('PATCH', '/api/me', { color: '#ABCDEF' }, u.token);
    expect(res.status).toBe(200);
    expect((await res.json<any>()).color).toBe('#ABCDEF');
  });

  it('bad color → 400', async () => {
    const u = await newUser();
    expect((await j('PATCH', '/api/me', { color: 'red' }, u.token)).status).toBe(400);
  });

  it('empty patch (nothing to update) → 400', async () => {
    const u = await newUser();
    expect((await j('PATCH', '/api/me', {}, u.token)).status).toBe(400);
  });

  it('nickname collision (case-insensitive) → 409', async () => {
    const a = await newUser();
    const b = await newUser();
    const res = await j('PATCH', '/api/me', { nickname: a.nickname.toUpperCase() }, b.token);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'nickname_taken' });
  });

  it('401 without token', async () => {
    expect((await j('PATCH', '/api/me', { color: '#000000' })).status).toBe(401);
  });
});

describe('avatars', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const putAvatar = (token: string, bytes: Uint8Array, ct = 'image/png') =>
    SELF.fetch(BASE + '/api/me/avatar', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': ct }, body: bytes });

  it('PUT valid png → 200 {avatarKey}, then GET round-trips bytes + headers', async () => {
    const u = await newUser();
    const put = await putAvatar(u.token, png);
    expect(put.status).toBe(200);
    expect(typeof (await put.json<any>()).avatarKey).toBe('string');

    const get = await SELF.fetch(`${BASE}/api/avatars/${u.userId}`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('cache-control')).toBe('public, max-age=300');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(png);
  });

  it('PUT over 512 KB → 413', async () => {
    const u = await newUser();
    const tooBig = new Uint8Array(512 * 1024 + 1);
    expect((await putAvatar(u.token, tooBig)).status).toBe(413);
  });

  it('PUT image/gif → 415', async () => {
    const u = await newUser();
    expect((await putAvatar(u.token, png, 'image/gif')).status).toBe(415);
  });

  it('GET avatar for user without one → 404', async () => {
    const u = await newUser();
    expect((await SELF.fetch(`${BASE}/api/avatars/${u.userId}`)).status).toBe(404);
  });
});

describe('profile broadcast', () => {
  it('connected WS receives profile after PATCH (via /internal/profile)', async () => {
    const u = await newUser();
    const serverId = (await (await j('POST', '/api/servers', { name: 's' + crypto.randomUUID().slice(0, 6) }, u.token)).json<any>()).id;

    const res = await SELF.fetch(`${BASE}/api/servers/${serverId}/ws?token=${u.token}`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const msgs: any[] = [];
    ws.accept();
    ws.addEventListener('message', (e: MessageEvent) => {
      msgs.push(JSON.parse(e.data as string));
    });

    const next = 'newname_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    expect((await j('PATCH', '/api/me', { nickname: next }, u.token)).status).toBe(200);

    let profile: any;
    for (let i = 0; i < 400 && !profile; i++) {
      profile = msgs.find((m) => m.t === 'profile');
      if (!profile) await new Promise((r) => setTimeout(r, 5));
    }
    expect(profile).toBeTruthy();
    expect(profile).toMatchObject({ userId: u.userId, nickname: next });
  });
});
