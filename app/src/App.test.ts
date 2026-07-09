import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import App from './App.svelte';
import { auth } from './lib/state/auth.svelte';
import { servers } from './lib/state/servers.svelte';
import { runtime } from './lib/state/runtime.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
  runtime.webcodecsOk = true;
  runtime.captureError = null;
});

test('shows onboarding when unauthed and swaps to the shell once a session lands', async () => {
  auth.reset();
  const screen = render(App);
  await expect.element(screen.getByLabelText('Nickname')).toBeInTheDocument();

  servers.setServers([{ id: 's1', name: 'Friends', role: 'owner' }]);
  auth.setSession('u1', 't', { userId: 'u1', nickname: 'Alice', color: '#8a8f98', avatarKey: null });
  flushSync();

  await expect.element(screen.getByText('Friends')).toBeInTheDocument();
});

// S6.3 DoD: missing VideoDecoder (mocked) → blocking error screen, Main never renders.
test('probe with VideoDecoder absent → blocking error screen', async () => {
  vi.stubGlobal('VideoDecoder', undefined);
  await runtime.probe(); // outside Tauri the engine report is a no-op
  expect(runtime.webcodecsOk).toBe(false);

  auth.setSession('u1', 't', { userId: 'u1', nickname: 'Alice', color: '#8a8f98', avatarKey: null });
  const screen = render(App);
  await expect.element(screen.getByTestId('webcodecs-error')).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('Friends');
});

// S6.3: the Linux portal probe error is a dismissible dialog, not a blocking screen.
test('captureError shows the typed dialog and dismisses', async () => {
  auth.reset();
  runtime.captureError = 'capture: portal unavailable: screen capture on Wayland requires xdg-desktop-portal + PipeWire';
  const screen = render(App);
  await expect.element(screen.getByTestId('capture-error')).toBeInTheDocument();

  runtime.dismissCaptureError();
  await expect.element(screen.getByTestId('capture-error')).not.toBeInTheDocument();
});
