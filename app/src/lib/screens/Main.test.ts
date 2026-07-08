import { render } from 'vitest-browser-svelte';
import { beforeEach, expect, test } from 'vitest';
import Main from './Main.svelte';
import { servers } from '../state/servers.svelte';
import { auth } from '../state/auth.svelte';
import { chat } from '../state/chat.svelte';

beforeEach(() => {
  servers.setServers([{ id: 's1', name: 'Friends', role: 'owner' }]);
  servers.setChannels('s1', [
    { id: 'c1', name: 'general', kind: 'text', hasPassword: false, unlocked: true },
    { id: 'c2', name: 'Lounge', kind: 'voice', hasPassword: false, unlocked: true },
  ]);
  servers.selectServer('s1');
  servers.setRoster('s1', [
    { userId: 'u1', nickname: 'Alice', color: '#8a8f98', avatarKey: null },
    { userId: 'u2', nickname: 'Bob', color: '#8a8f98', avatarKey: null },
  ]);
  servers.applyPresence('s1', { userId: 'u1', state: 'online', channelId: null });
  auth.setSession('u1', 't', { userId: 'u1', nickname: 'Alice', color: '#8a8f98', avatarKey: null });
  chat.reset();
  chat.add({ id: 1, channelId: 'c1', userId: 'u2', content: 'hello there', nonce: null, createdAt: 1 });
});

test('renders the shell: server name, channels, selected-channel chat, member dot', async () => {
  const screen = render(Main);
  await expect.element(screen.getByText('Friends')).toBeInTheDocument();
  await expect.element(screen.getByText('Lounge')).toBeInTheDocument();
  await expect.element(screen.getByText('hello there')).toBeInTheDocument();
  await expect.element(screen.getByTestId('dot-u1')).toHaveClass('online');
});
