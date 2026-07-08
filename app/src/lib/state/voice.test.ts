import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { voice, JOIN_TIMEOUT_MS } from './voice.svelte';
import { auth } from './auth.svelte';
import { servers } from './servers.svelte';
import { emitEngineEvent } from '../events';
import type { TrackInfo } from '../protocol/TrackInfo';

// S4.2 DoD: the §1 fixed sequencing, asserted on one shared `order` log that
// interleaves WS frames (sendFrame spy) with engine commands (mockIPC).

let order: string[] = [];

beforeEach(() => {
  order.length = 0;
  auth.reset();
  servers.reset();
  voice.reset();
  localStorage.clear();
  auth.setSession('me', 'tok', { userId: 'me', nickname: 'Me', color: '#8a8f98', avatarKey: null });
  voice.sendFrame = (serverId, frame) => order.push(`ws:${frame.t}:${serverId}`);
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown> | undefined;
    order.push(cmd === 'set_user_gain' ? `${cmd}:${a?.userId}:${a?.gain}` : cmd);
    if (cmd === 'voice_join') return { trackName: 'mic-x' };
    return null;
  });
});
afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

async function joinAndConfirm(serverId: string, channelId: string): Promise<void> {
  const p = voice.join(serverId, channelId);
  await vi.waitFor(() => expect(order).toContain(`ws:voice.join:${serverId}`));
  voice.notifyPresence(serverId, { userId: 'me', state: 'voice', channelId });
  await p;
}

test('join: engine voice_join is NOT invoked before our own voice presence arrives', async () => {
  const p = voice.join('s1', 'c1');
  await Promise.resolve();
  expect(order).toEqual(['ws:voice.join:s1']); // WS frame out, engine untouched
  expect(voice.status).toBe('joining');

  // Foreign presence must not resolve the waiter: other user / wrong state / wrong channel.
  voice.notifyPresence('s1', { userId: 'bob', state: 'voice', channelId: 'c1' });
  voice.notifyPresence('s1', { userId: 'me', state: 'online', channelId: null });
  voice.notifyPresence('s1', { userId: 'me', state: 'voice', channelId: 'other' });
  expect(order).not.toContain('voice_join');
  expect(voice.status).toBe('joining');

  voice.notifyPresence('s1', { userId: 'me', state: 'voice', channelId: 'c1' });
  await p;
  expect(voice.status).toBe('in');
  expect(voice.micTrackName).toBe('mic-x');
  expect(order.indexOf('voice_join')).toBeGreaterThan(order.indexOf('ws:voice.join:s1'));
});

test('join: 5 s without our presence → error toast state, engine never invoked', async () => {
  vi.useFakeTimers();
  const p = voice.join('s1', 'c1');
  await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS);
  await p;
  expect(order).toEqual(['ws:voice.join:s1', 'ws:voice.leave:s1']); // best-effort converge
  expect(order).not.toContain('voice_join');
  expect(voice.status).toBe('idle');
  expect(voice.error).toMatch(/timed out/);
});

test('leave: engine voice_leave precedes the WS voice.leave (§1 reversed order)', async () => {
  await joinAndConfirm('s1', 'c1');
  order.length = 0;

  await voice.leave();

  const eng = order.indexOf('voice_leave');
  const ws = order.indexOf('ws:voice.leave:s1');
  expect(eng).toBeGreaterThanOrEqual(0);
  expect(ws).toBeGreaterThan(eng);
  expect(voice.status).toBe('idle');
});

test('cross-server join performs a full leave of the old server first', async () => {
  await joinAndConfirm('s1', 'c1');
  order.length = 0;

  const p = voice.join('s2', 'c2');
  await vi.waitFor(() => expect(order).toContain('ws:voice.join:s2'));
  voice.notifyPresence('s2', { userId: 'me', state: 'voice', channelId: 'c2' });
  await p;

  const seq = order.filter((x) =>
    ['voice_leave', 'ws:voice.leave:s1', 'ws:voice.join:s2', 'voice_join'].includes(x),
  );
  expect(seq).toEqual(['voice_leave', 'ws:voice.leave:s1', 'ws:voice.join:s2', 'voice_join']);
  expect(voice.serverId).toBe('s2');
  expect(voice.channelId).toBe('c2');
});

test('persisted per-user gain is re-applied after joining (§1 slider re-apply)', async () => {
  localStorage.setItem('gain:bob', '1.5');
  servers.setServers([{ id: 's1', name: 'S', role: 'member' }]);
  servers.setPresence('s1', [{ userId: 'bob', state: 'voice', channelId: 'c1' }]);

  await joinAndConfirm('s1', 'c1');
  expect(order).toContain('set_user_gain:bob:1.5');

  // A user entering our channel later also gets their stored gain applied.
  localStorage.setItem('gain:cara', '0.5');
  voice.notifyPresence('s1', { userId: 'cara', state: 'voice', channelId: 'c1' });
  expect(order).toContain('set_user_gain:cara:0.5');
});

test('setGain persists + invokes; gain() clamps to 0–2 and defaults to 1', () => {
  voice.setGain('bob', 1.25);
  expect(localStorage.getItem('gain:bob')).toBe('1.25');
  expect(order).toContain('set_user_gain:bob:1.25');
  expect(voice.gain('bob')).toBe(1.25);
  expect(voice.gain('unknown')).toBe(1);
  localStorage.setItem('gain:x', '9');
  expect(voice.gain('x')).toBe(2);
});

test('speaking: RMS > 0.02 sustained ≥100 ms turns the ring on; below turns it off', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  emitEngineEvent('engine://levels', [{ userId: 'bob', rms: 0.05 }]);
  expect(voice.speaking['bob']).toBeFalsy(); // first sample only starts the hold clock

  vi.setSystemTime(1_000_100);
  emitEngineEvent('engine://levels', [{ userId: 'bob', rms: 0.05 }]);
  expect(voice.speaking['bob']).toBe(true);

  emitEngineEvent('engine://levels', [{ userId: 'bob', rms: 0.001 }]);
  expect(voice.speaking['bob']).toBe(false);
});

test('tracks rosters are forwarded to the engine while in voice', async () => {
  const t: TrackInfo = {
    ownerId: 'bob',
    trackName: 'mic-b',
    kind: 'mic',
    simulcast: false,
    width: 0,
    height: 0,
    fps: 0,
  };
  // Idle: remembered but not forwarded (engine only cares while in voice).
  voice.applyTracks('s1', 'bob', [t]);
  expect(order).not.toContain('set_remote_tracks');

  await joinAndConfirm('s1', 'c1'); // join forwards the remembered snapshot
  await vi.waitFor(() => expect(order).toContain('set_remote_tracks'));

  order.length = 0;
  voice.applyTracks('s1', 'bob', []); // bob unpublished → forward again
  await vi.waitFor(() => expect(order).toContain('set_remote_tracks'));
});
