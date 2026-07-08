import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { expect, test } from 'vitest';
import App from './App.svelte';
import { auth } from './lib/state/auth.svelte';
import { servers } from './lib/state/servers.svelte';

test('shows onboarding when unauthed and swaps to the shell once a session lands', async () => {
  auth.reset();
  const screen = render(App);
  await expect.element(screen.getByLabelText('Nickname')).toBeInTheDocument();

  servers.setServers([{ id: 's1', name: 'Friends', role: 'owner' }]);
  auth.setSession('u1', 't', { userId: 'u1', nickname: 'Alice', color: '#8a8f98', avatarKey: null });
  flushSync();

  await expect.element(screen.getByText('Friends')).toBeInTheDocument();
});
