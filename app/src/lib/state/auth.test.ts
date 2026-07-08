import { afterEach, expect, test, vi } from 'vitest';
import { AuthStore } from './auth.svelte';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const session = {
  userId: 'u1',
  token: 't1',
  profile: { userId: 'u1', nickname: 'alice', color: '#8a8f98', avatarKey: null },
};

test('register stores the session on success', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(session, 201)),
  );
  const store = new AuthStore();
  await store.register('alice', 'password1', 'password1');
  expect(store.authed).toBe(true);
  expect(store.token).toBe('t1');
  expect(store.profile?.nickname).toBe('alice');
  expect(store.error).toBeNull();
});

test('surfaces the error code and stays unauthed on failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ code: 'nickname_taken' }, 409)),
  );
  const store = new AuthStore();
  await store.register('alice', 'password1', 'password1');
  expect(store.authed).toBe(false);
  expect(store.error).toBe('nickname_taken');
});

test('login posts to /api/login', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ ...session, token: 't2' }, 200));
  vi.stubGlobal('fetch', fetchMock);
  const store = new AuthStore();
  await store.login('alice', 'password1');
  expect(store.token).toBe('t2');
  expect(String(fetchMock.mock.calls[0][0])).toContain('/api/login');
});
