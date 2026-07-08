import { afterEach, expect, test, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { restoreSession } from './boot';
import { auth } from './state/auth.svelte';
import { servers } from './state/servers.svelte';
import { API_BASE } from './api';

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

function stubMe(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
}

test('valid stored token → session active, servers loaded, engine configured', async () => {
  auth.reset();
  const calls: Record<string, unknown> = {};
  mockIPC((cmd, payload) => {
    calls[cmd] = payload ?? null;
    if (cmd === 'session_load') return { userId: 'u1', token: 't1' };
    return null;
  });
  stubMe(200, {
    userId: 'u1',
    nickname: 'Alice',
    color: '#8a8f98',
    avatarKey: null,
    servers: [{ id: 's1', name: 'Friends' }],
  });

  await restoreSession();

  expect(auth.authed).toBe(true);
  expect(auth.profile?.nickname).toBe('Alice');
  expect(servers.list.map((s) => s.id)).toEqual(['s1']);
  expect(calls.engine_configure).toEqual({ apiBase: API_BASE, token: 't1' });
});

test('invalid stored token → keyring cleared, stays on onboarding', async () => {
  auth.reset();
  let cleared = false;
  mockIPC((cmd) => {
    if (cmd === 'session_load') return { userId: 'u1', token: 'dead' };
    if (cmd === 'session_clear') cleared = true;
    return null;
  });
  stubMe(401, { code: 'unauthorized' });

  await restoreSession();

  expect(auth.authed).toBe(false);
  expect(cleared).toBe(true);
});
