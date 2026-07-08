import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import {
  createServer,
  joinServer,
  createChannel,
  unlockChannel,
  saveProfile,
  uploadAvatar,
  logout,
} from './actions';
import { auth } from './state/auth.svelte';
import { servers } from './state/servers.svelte';
import { ApiError } from './api';

type Route = (url: string, init: { method?: string; body?: unknown }) => Response;

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function routeFetch(route: Route) {
  const mock = vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => route(String(url), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  auth.reset();
  servers.reset();
  auth.setSession('u1', 't1', { userId: 'u1', nickname: 'Alice', color: '#8a8f98', avatarKey: null });
});
afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

test('createServer posts, adds as owner, selects it, loads channels', async () => {
  const fetchMock = routeFetch((url, init) => {
    if (url.endsWith('/api/servers') && init.method === 'POST') return json(201, { id: 's9', name: 'Friends' });
    if (url.endsWith('/api/servers/s9/channels')) return json(200, []);
    return json(404, {});
  });
  await createServer('Friends');
  expect(servers.list).toContainEqual({ id: 's9', name: 'Friends', role: 'owner' });
  expect(servers.currentServerId).toBe('s9');
  expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/api/servers') && i?.method === 'POST')).toBe(true);
});

test('joinServer surfaces 403 wrong_password as an ApiError', async () => {
  routeFetch((url) => (url.endsWith('/api/servers/join') ? json(403, { code: 'wrong_password' }) : json(200, [])));
  await expect(joinServer('s9', 'nope')).rejects.toBeInstanceOf(ApiError);
});

test('createChannel posts with kind then reloads channels', async () => {
  servers.setServers([{ id: 's1', name: 'S', role: 'owner' }]);
  servers.selectServer('s1');
  let posted: unknown;
  routeFetch((url, init) => {
    if (url.endsWith('/api/servers/s1/channels') && init.method === 'POST') {
      posted = JSON.parse(init.body as string);
      return json(201, { id: 'c9' });
    }
    return json(200, [{ id: 'c9', name: 'voice', kind: 'voice', hasPassword: false, unlocked: true }]);
  });
  await createChannel('s1', 'voice', 'voice');
  expect(posted).toMatchObject({ name: 'voice', kind: 'voice' });
  expect(servers.channelsByServer['s1']).toHaveLength(1);
});

test('unlockChannel throws ApiError on 429 rate limit', async () => {
  routeFetch(() => json(429, { code: 'rate_limited' }));
  await expect(unlockChannel('c1', 'pw')).rejects.toMatchObject({ status: 429 });
});

test('saveProfile updates the local profile from the response', async () => {
  routeFetch(() => json(200, { userId: 'u1', nickname: 'Alice2', color: '#000000', avatarKey: null }));
  await saveProfile({ nickname: 'Alice2' });
  expect(auth.profile?.nickname).toBe('Alice2');
});

test('uploadAvatar rejects wrong type and oversize, accepts a valid image', async () => {
  await expect(uploadAvatar(new File(['x'], 'a.gif', { type: 'image/gif' }))).rejects.toThrow('unsupported_type');
  await expect(
    uploadAvatar(new File([new Uint8Array(512 * 1024 + 1)], 'big.png', { type: 'image/png' })),
  ).rejects.toThrow('too_large');

  routeFetch(() => json(200, { avatarKey: 'k1' }));
  await uploadAvatar(new File(['x'], 'a.png', { type: 'image/png' }));
  expect(auth.profile?.avatarKey).toBe('k1');
});

test('logout posts, clears the keyring, and resets auth', async () => {
  let cleared = false;
  mockIPC((cmd) => {
    if (cmd === 'session_clear') cleared = true;
    return null;
  });
  const fetchMock = routeFetch(() => json(204, undefined));

  await logout();

  expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/api/logout') && i?.method === 'POST')).toBe(true);
  expect(cleared).toBe(true);
  expect(auth.authed).toBe(false);
  expect(servers.list).toEqual([]);
});
