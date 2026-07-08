import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import VoicePanel from './VoicePanel.svelte';
import { voice } from '../state/voice.svelte';
import { auth } from '../state/auth.svelte';
import { servers } from '../state/servers.svelte';
import { emitEngineEvent } from '../events';

// S4.2 DoD component tests: deafen button state, slider persistence, speaking ring,
// error toast. Sequencing itself is covered store-level in state/voice.test.ts.

let invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];

function seedInVoice(): void {
  voice.status = 'in';
  voice.serverId = 's1';
  voice.channelId = 'c1';
  servers.setServers([{ id: 's1', name: 'S', role: 'member' }]);
  servers.setChannels('s1', [
    { id: 'c1', name: 'General VC', kind: 'voice', hasPassword: false, unlocked: true },
  ]);
  servers.setRoster('s1', [{ userId: 'bob', nickname: 'Bob', color: '#00ff00', avatarKey: null }]);
  servers.setPresence('s1', [{ userId: 'bob', state: 'voice', channelId: 'c1' }]);
}

beforeEach(() => {
  invokes = [];
  auth.reset();
  servers.reset();
  voice.reset();
  localStorage.clear();
  auth.setSession('me', 'tok', { userId: 'me', nickname: 'Me', color: '#8a8f98', avatarKey: null });
  voice.sendFrame = () => {};
  mockIPC((cmd, args) => {
    invokes.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    return null;
  });
});
afterEach(() => {
  clearMocks();
});

test('deafen button: pressed state + engine command, and mute is left untouched', async () => {
  const screen = render(VoicePanel);
  const deafen = screen.getByRole('button', { name: 'Deafen' });
  await deafen.click();

  await expect.element(screen.getByRole('button', { name: 'Undeafen' })).toHaveAttribute('aria-pressed', 'true');
  expect(invokes).toContainEqual({ cmd: 'set_deafened', args: { deafened: true } });
  // §1: deafen must not clobber the mic state — the Mute button still reads "Mute".
  await expect.element(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');

  await screen.getByRole('button', { name: 'Undeafen' }).click();
  expect(invokes).toContainEqual({ cmd: 'set_deafened', args: { deafened: false } });
  await expect.element(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');
});

test('participant slider: initial value from the persisted pref, change persists + invokes', async () => {
  localStorage.setItem('gain:bob', '1.5');
  seedInVoice();
  const screen = render(VoicePanel);

  const slider = screen.getByLabelText('Volume for Bob');
  await expect.element(slider).toHaveValue('150'); // persisted 1.5 → 150%

  const el = slider.element() as HTMLInputElement;
  el.value = '60';
  el.dispatchEvent(new Event('input', { bubbles: true }));

  await vi.waitFor(() => {
    expect(localStorage.getItem('gain:bob')).toBe('0.6');
    expect(invokes).toContainEqual({ cmd: 'set_user_gain', args: { userId: 'bob', gain: 0.6 } });
  });
});

test('speaking ring turns on for a participant after sustained synthetic levels', async () => {
  seedInVoice();
  const screen = render(VoicePanel);
  const dot = screen.getByTestId('vdot-bob');
  await expect.element(dot).not.toHaveClass('speaking');

  emitEngineEvent('engine://levels', [{ userId: 'bob', rms: 0.05 }]);
  await new Promise((r) => setTimeout(r, 110)); // §1 hold: ≥100 ms above threshold
  emitEngineEvent('engine://levels', [{ userId: 'bob', rms: 0.05 }]);
  await expect.element(dot).toHaveClass('speaking');

  emitEngineEvent('engine://levels', [{ userId: 'bob', rms: 0.001 }]);
  await expect.element(dot).not.toHaveClass('speaking');
});

test('join-timeout error renders as a toast (role=alert)', async () => {
  voice.error = 'Could not join voice (timed out)';
  const screen = render(VoicePanel);
  await expect.element(screen.getByRole('alert')).toHaveTextContent('Could not join voice (timed out)');
});

test('leave button tears down: engine voice_leave then panel back to "Not in voice"', async () => {
  seedInVoice();
  const screen = render(VoicePanel);
  await expect.element(screen.getByText('🔊 General VC')).toBeInTheDocument();

  await screen.getByRole('button', { name: 'Leave' }).click();

  await expect.element(screen.getByText('Not in voice')).toBeInTheDocument();
  expect(invokes.map((i) => i.cmd)).toContain('voice_leave');
});
