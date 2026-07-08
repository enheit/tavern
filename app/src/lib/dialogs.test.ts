import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import CreateServerDialog from './components/dialogs/CreateServerDialog.svelte';
import JoinServerDialog from './components/dialogs/JoinServerDialog.svelte';
import CreateChannelDialog from './components/dialogs/CreateChannelDialog.svelte';
import UnlockDialog from './components/dialogs/UnlockDialog.svelte';
import SettingsModal from './components/dialogs/SettingsModal.svelte';
import { auth } from './state/auth.svelte';
import { servers } from './state/servers.svelte';

type Init = { method?: string; body?: unknown };

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function routeFetch(route: (url: string, init: Init) => Response) {
  const mock = vi.fn(async (url: string, init: Init = {}) => route(String(url), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

const posted = (mock: ReturnType<typeof routeFetch>, suffix: string) =>
  mock.mock.calls.some(([u, i]) => String(u).endsWith(suffix) && (i as Init)?.method === 'POST');

beforeEach(() => {
  auth.reset();
  servers.reset();
  auth.setSession('u1', 't1', { userId: 'u1', nickname: 'Alice', color: '#8a8f98', avatarKey: null });
});
afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

// ---- Create server --------------------------------------------------------

test('CreateServer: submit is gated on a valid name', async () => {
  const screen = render(CreateServerDialog, { onclose: vi.fn() });
  await expect.element(screen.getByTestId('submit')).toBeDisabled();
  await screen.getByLabelText('Name', { exact: true }).fill('Friends');
  await expect.element(screen.getByTestId('submit')).toBeEnabled();
});

test('CreateServer: a valid submit POSTs and closes', async () => {
  const onclose = vi.fn();
  const fetchMock = routeFetch((url, init) =>
    url.endsWith('/api/servers') && init.method === 'POST' ? json(201, { id: 's9', name: 'Friends' }) : json(200, []),
  );
  const screen = render(CreateServerDialog, { onclose });
  await screen.getByLabelText('Name', { exact: true }).fill('Friends');
  await screen.getByTestId('submit').click();
  await vi.waitFor(() => expect(onclose).toHaveBeenCalledTimes(1));
  expect(posted(fetchMock, '/api/servers')).toBe(true);
});

// ---- Join server ----------------------------------------------------------

test('JoinServer: a valid submit POSTs and closes', async () => {
  const onclose = vi.fn();
  routeFetch((url) => (url.endsWith('/api/servers/join') ? json(200, { id: 's9', name: 'X' }) : json(200, [])));
  const screen = render(JoinServerDialog, { onclose });
  await screen.getByLabelText('Server ID').fill('s9');
  await screen.getByTestId('submit').click();
  await vi.waitFor(() => expect(onclose).toHaveBeenCalled());
});

test('JoinServer: 403 renders "Wrong password" and stays open', async () => {
  const onclose = vi.fn();
  routeFetch(() => json(403, { code: 'wrong_password' }));
  const screen = render(JoinServerDialog, { onclose });
  await screen.getByLabelText('Server ID').fill('s9');
  await screen.getByTestId('submit').click();
  await expect.element(screen.getByText('Wrong password')).toBeInTheDocument();
  expect(onclose).not.toHaveBeenCalled();
});

// ---- Create channel -------------------------------------------------------

test('CreateChannel: submit is gated on a valid name', async () => {
  const screen = render(CreateChannelDialog, { serverId: 's1', onclose: vi.fn() });
  await expect.element(screen.getByTestId('submit')).toBeDisabled();
  await screen.getByLabelText('Name', { exact: true }).fill('general');
  await expect.element(screen.getByTestId('submit')).toBeEnabled();
});

test('CreateChannel: POSTs name + selected kind', async () => {
  const onclose = vi.fn();
  let body: unknown;
  routeFetch((url, init) => {
    if (url.endsWith('/api/servers/s1/channels') && init.method === 'POST') {
      body = JSON.parse(init.body as string);
      return json(201, { id: 'c9' });
    }
    return json(200, []);
  });
  const screen = render(CreateChannelDialog, { serverId: 's1', onclose });
  await screen.getByLabelText('Name', { exact: true }).fill('general');
  await screen.getByTestId('submit').click();
  await vi.waitFor(() => expect(onclose).toHaveBeenCalled());
  expect(body).toMatchObject({ name: 'general', kind: 'text' });
});

// ---- Unlock (error rendering) --------------------------------------------

test('Unlock: 403 renders "Wrong password"', async () => {
  routeFetch(() => json(403, {}));
  const screen = render(UnlockDialog, { channelId: 'c1', channelName: 'secret', onclose: vi.fn() });
  await screen.getByLabelText('Password').fill('x');
  await screen.getByTestId('submit').click();
  await expect.element(screen.getByText('Wrong password')).toBeInTheDocument();
});

test('Unlock: 429 renders the rate-limit message', async () => {
  routeFetch(() => json(429, {}));
  const screen = render(UnlockDialog, { channelId: 'c1', channelName: 'secret', onclose: vi.fn() });
  await screen.getByLabelText('Password').fill('x');
  await screen.getByTestId('submit').click();
  await expect.element(screen.getByText('Too many attempts — wait a minute')).toBeInTheDocument();
});

// ---- Settings + logout ----------------------------------------------------

test('Settings: an invalid color disables Save', async () => {
  const screen = render(SettingsModal, { onclose: vi.fn() });
  await expect.element(screen.getByTestId('save')).toBeEnabled();
  await screen.getByLabelText('Color').fill('nothex');
  await expect.element(screen.getByTestId('save')).toBeDisabled();
});

test('Settings: saving a changed nickname PATCHes /api/me', async () => {
  const onclose = vi.fn();
  const fetchMock = routeFetch(() => json(200, { userId: 'u1', nickname: 'Alice2', color: '#8a8f98', avatarKey: null }));
  const screen = render(SettingsModal, { onclose });
  await screen.getByLabelText('Nickname').fill('Alice2');
  await screen.getByTestId('save').click();
  await vi.waitFor(() => expect(onclose).toHaveBeenCalled());
  expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/api/me') && (i as Init)?.method === 'PATCH')).toBe(true);
  expect(auth.profile?.nickname).toBe('Alice2');
});

test('Settings: Log out POSTs, clears the keyring, and resets auth', async () => {
  let cleared = false;
  mockIPC((cmd) => {
    if (cmd === 'session_clear') cleared = true;
    return null;
  });
  const fetchMock = routeFetch(() => json(204, undefined));
  const onclose = vi.fn();
  const screen = render(SettingsModal, { onclose });

  await screen.getByTestId('logout').click();

  await vi.waitFor(() => expect(auth.authed).toBe(false));
  expect(posted(fetchMock, '/api/logout')).toBe(true);
  expect(cleared).toBe(true);
  expect(onclose).toHaveBeenCalled();
});
