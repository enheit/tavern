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

// ---- S6.1 WS-resume reconnection ------------------------------------------------

const screenTrack: TrackInfo = {
  ownerId: 'bob',
  trackName: 'screen-b',
  kind: 'screen',
  simulcast: true,
  width: 1280,
  height: 720,
  fps: 30,
};

test('resumeAfterWs: full leave → re-join → re-publish share → watched/pinned restored', async () => {
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown> | undefined;
    order.push(cmd === 'set_user_gain' ? `${cmd}:${a?.userId}:${a?.gain}` : cmd);
    if (cmd === 'voice_join') return { trackName: 'mic-x' };
    if (cmd === 'screen_share_start') return { trackName: 'screen-me' };
    return null;
  });
  servers.setPresence('s1', [{ userId: 'bob', state: 'voice', channelId: 'c1' }]);
  await joinAndConfirm('s1', 'c1');
  await voice.shareStart('screen:primary', 1280, 720, 30);
  voice.applyTracks('s1', 'bob', [screenTrack]);
  voice.joinStream(screenTrack);
  voice.togglePin(screenTrack);
  expect(voice.watched).toEqual({ 'bob/screen-b': 'h' });
  order.length = 0;

  const p = voice.resumeAfterWs('s1');
  expect(voice.reconnecting).toBe(true);
  await vi.waitFor(() => expect(order.filter((x) => x === 'ws:voice.join:s1').length).toBe(1));
  voice.notifyPresence('s1', { userId: 'me', state: 'voice', channelId: 'c1' });
  await p;

  // Sequence: engine leave → WS leave → WS join → engine join → re-publish the share.
  const seq = order.filter((x) =>
    ['voice_leave', 'ws:voice.leave:s1', 'ws:voice.join:s1', 'voice_join', 'screen_share_start'].includes(x),
  );
  expect(seq).toEqual(['voice_leave', 'ws:voice.leave:s1', 'ws:voice.join:s1', 'voice_join', 'screen_share_start']);
  expect(voice.status).toBe('in');
  expect(voice.sharing?.trackName).toBe('screen-me');
  // Watch state restored (tiles re-subscribe off the fresh `watched` object).
  expect(voice.watched).toEqual({ 'bob/screen-b': 'h' });
  expect(voice.pinned).toBe('bob/screen-b');
  expect(voice.reconnecting).toBe(false);
});

test('resumeAfterWs is a no-op when idle or for a different server', async () => {
  await voice.resumeAfterWs('s1'); // idle
  expect(order).toEqual([]);

  await joinAndConfirm('s1', 'c1');
  order.length = 0;
  await voice.resumeAfterWs('s2'); // some other server's socket resumed
  expect(order).toEqual([]);
  expect(voice.status).toBe('in');
});

test('reconnecting banner: engine ICE `reconnecting` while in voice; cleared on recovery', async () => {
  expect(voice.reconnecting).toBe(false);
  emitEngineEvent('engine://state', { voice: 'reconnecting' });
  expect(voice.reconnecting).toBe(false); // not in voice → no banner

  await joinAndConfirm('s1', 'c1');
  emitEngineEvent('engine://state', { voice: 'reconnecting' });
  expect(voice.reconnecting).toBe(true);
  emitEngineEvent('engine://state', { voice: 'connected' });
  expect(voice.reconnecting).toBe(false);
});

test('a stopped share is not re-published on resume', async () => {
  mockIPC((cmd) => {
    order.push(cmd);
    if (cmd === 'voice_join') return { trackName: 'mic-x' };
    if (cmd === 'screen_share_start') return { trackName: 'screen-me' };
    return null;
  });
  await joinAndConfirm('s1', 'c1');
  await voice.shareStart('screen:primary', 1280, 720, 30);
  await voice.shareStop();
  order.length = 0;

  const p = voice.resumeAfterWs('s1');
  await vi.waitFor(() => expect(order).toContain('ws:voice.join:s1'));
  voice.notifyPresence('s1', { userId: 'me', state: 'voice', channelId: 'c1' });
  await p;
  expect(order).not.toContain('screen_share_start');
  expect(voice.sharing).toBeNull();
});

test('engine reconnect_failed event triggers the full re-join (S6.1)', async () => {
  await joinAndConfirm('s1', 'c1');
  order.length = 0;

  emitEngineEvent('engine://state', { voice: 'reconnecting', err: 'reconnect_failed' });
  await vi.waitFor(() => expect(order).toContain('ws:voice.join:s1'));
  voice.notifyPresence('s1', { userId: 'me', state: 'voice', channelId: 'c1' });
  await vi.waitFor(() => expect(voice.status).toBe('in'));

  const seq = order.filter((x) => ['voice_leave', 'ws:voice.join:s1', 'voice_join'].includes(x));
  expect(seq).toEqual(['voice_leave', 'ws:voice.join:s1', 'voice_join']);
});

// ---- S6.2 budget UI state ---------------------------------------------------

test('budget soft: tiles auto-drop to l (fresh watched object) and pin clears', () => {
  voice.applyTracks('s1', 'bob', [screenTrack]);
  servers.setPresence('s1', [{ userId: 'bob', state: 'voice', channelId: 'c1' }]);
  voice.serverId = 's1';
  voice.channelId = 'c1';
  voice.status = 'in';
  voice.joinStream(screenTrack);
  voice.togglePin(screenTrack);
  expect(voice.watched).toEqual({ 'bob/screen-b': 'h' });
  const before = voice.watched;

  voice.applyBudget({ level: 'soft', estMbps: 1.2, monthGb: 850 });
  expect(voice.budgetLevel).toBe('soft');
  expect(voice.pinned).toBeNull();
  expect(voice.watched).toEqual({ 'bob/screen-b': 'l' }); // downgrade dispatched
  expect(voice.watched).not.toBe(before); // fresh object → tile effects re-run

  // Pin is disabled while budget-limited.
  voice.togglePin(screenTrack);
  expect(voice.pinned).toBeNull();

  // Back to ok → pinning works again.
  voice.applyBudget({ level: 'ok', estMbps: 0, monthGb: 10 });
  voice.togglePin(screenTrack);
  expect(voice.pinned).toBe('bob/screen-b');
});

test('budget hard: joinStream is a no-op (watch disabled)', () => {
  voice.applyBudget({ level: 'hard', estMbps: 0, monthGb: 960 });
  voice.joinStream(screenTrack);
  expect(voice.watched).toEqual({});
});
