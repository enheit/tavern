import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Random-fixture rule (test/README.md): each test makes its own user. nickname
// must match ^[A-Za-z0-9_]{2,32}$, so derive from a hyphen-stripped uuid.
const nick = () => 'u' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);

const BASE = 'https://tavern.test';
const post = (path: string, body: unknown, token?: string) =>
  SELF.fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const get = (path: string, token?: string) =>
  SELF.fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function register(nickname: string, password = 'hunter2pw') {
  const res = await post('/api/register', { nickname, password, repeat: password });
  return { res, body: res.status === 201 ? await res.json<any>() : null };
}

describe('auth: register', () => {
  it('happy path → 201 {userId, token, profile}', async () => {
    const n = nick();
    const { res, body } = await register(n);
    expect(res.status).toBe(201);
    expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.token).toBe('string');
    expect(body.profile).toEqual({
      userId: body.userId,
      nickname: n,
      color: '#8a8f98',
      avatarKey: null,
    });
  });

  it('400 on bad nickname (regex)', async () => {
    const res = await post('/api/register', {
      nickname: 'has space',
      password: 'hunter2pw',
      repeat: 'hunter2pw',
    });
    expect(res.status).toBe(400);
  });

  it('400 on short password (<8)', async () => {
    const res = await post('/api/register', { nickname: nick(), password: 'short', repeat: 'short' });
    expect(res.status).toBe(400);
  });

  it('400 on password/repeat mismatch', async () => {
    const res = await post('/api/register', {
      nickname: nick(),
      password: 'hunter2pw',
      repeat: 'hunter2xx',
    });
    expect(res.status).toBe(400);
  });

  it('400 on non-JSON body', async () => {
    const res = await SELF.fetch(BASE + '/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('409 nickname_taken, case-insensitive', async () => {
    const n = nick();
    expect((await register(n)).res.status).toBe(201);
    const dup = await register(n.toUpperCase());
    expect(dup.res.status).toBe(409);
    expect(await dup.res.json<any>()).toEqual({ code: 'nickname_taken' });
  });
});

describe('auth: login', () => {
  it('happy register → login → me', async () => {
    const n = nick();
    await register(n);
    const login = await post('/api/login', { nickname: n, password: 'hunter2pw' });
    expect(login.status).toBe(200);
    const { token, userId } = await login.json<any>();

    const me = await get('/api/me', token);
    expect(me.status).toBe(200);
    expect(await me.json<any>()).toEqual({
      userId,
      nickname: n,
      color: '#8a8f98',
      avatarKey: null,
      servers: [],
    });
  });

  it('login matches nickname case-insensitively', async () => {
    const n = nick();
    await register(n);
    const login = await post('/api/login', { nickname: n.toUpperCase(), password: 'hunter2pw' });
    expect(login.status).toBe(200);
  });

  it('401 on wrong password', async () => {
    const n = nick();
    await register(n);
    const login = await post('/api/login', { nickname: n, password: 'wrong-password' });
    expect(login.status).toBe(401);
  });

  it('401 on unknown nickname', async () => {
    const login = await post('/api/login', { nickname: nick(), password: 'hunter2pw' });
    expect(login.status).toBe(401);
  });

  it('400 on non-JSON login body', async () => {
    const res = await SELF.fetch(BASE + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('auth: me + logout', () => {
  it('401 on /me without token', async () => {
    expect((await get('/api/me')).status).toBe(401);
  });

  it('401 on /me with a bogus token', async () => {
    expect((await get('/api/me', 'not-a-real-token')).status).toBe(401);
  });

  it('logout revokes the token (204, then /me → 401)', async () => {
    const n = nick();
    const { body } = await register(n);
    const token = body.token;

    expect((await get('/api/me', token)).status).toBe(200);
    const out = await post('/api/logout', {}, token);
    expect(out.status).toBe(204);
    expect((await get('/api/me', token)).status).toBe(401);
  });

  it('401 on logout without token', async () => {
    expect((await post('/api/logout', {})).status).toBe(401);
  });
});
