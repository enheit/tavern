import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import App from './App.svelte';
import { auth } from './lib/state/auth.svelte';
import { servers } from './lib/state/servers.svelte';
import { runtime } from './lib/state/runtime.svelte';
import { emitEngineEvent } from './lib/events';

afterEach(() => {
  vi.unstubAllGlobals();
  runtime.webcodecsOk = true;
  runtime.captureError = null;
  runtime.updateVersion = null;
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
// The requirement is DESKTOP-only (the S7 web build renders watched streams via
// <video>, no WebCodecs needed), so the probe blocks only under the Tauri marker.
test('probe with VideoDecoder absent → blocking error screen', async () => {
  vi.stubGlobal('VideoDecoder', undefined);
  mockIPC(() => undefined); // provides __TAURI_INTERNALS__ → desktop probe semantics
  try {
    await runtime.probe();
  } finally {
    clearMocks();
  }
  expect(runtime.webcodecsOk).toBe(false);

  auth.setSession('u1', 't', { userId: 'u1', nickname: 'Alice', color: '#8a8f98', avatarKey: null });
  const screen = render(App);
  await expect.element(screen.getByTestId('webcodecs-error')).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('Friends');
});

// update://ready → restart pill appears (relaunch itself is a no-op outside Tauri).
test('installed update shows the restart pill', async () => {
  auth.reset();
  const screen = render(App);
  emitEngineEvent('update://ready', '0.2.0');
  await expect.element(screen.getByTestId('update-ready')).toBeInTheDocument();
  expect(screen.container.textContent).toContain('0.2.0');
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
