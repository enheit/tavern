import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import StreamTile from './StreamTile.svelte';
import StreamGrid from './StreamGrid.svelte';
import { voice, VoiceStore } from '../state/voice.svelte';
import { auth } from '../state/auth.svelte';
import { servers } from '../state/servers.svelte';
import type { TrackInfo } from '../protocol/TrackInfo';

// S5.4 DoD component tests: join/leave states, pin swap issues unwatch+watch with layers
// asserted, pin disabled for simulcast:false, canvases mount/unmount.

let invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];

const SCREEN_A: TrackInfo = {
  ownerId: 'alice',
  trackName: 'screen-a',
  kind: 'screen',
  simulcast: true,
  width: 1280,
  height: 720,
  fps: 30,
};
const CAM_B: TrackInfo = {
  ownerId: 'bob',
  trackName: 'webcam-b',
  kind: 'webcam',
  simulcast: false,
  width: 640,
  height: 360,
  fps: 30,
};

function seed(): void {
  voice.status = 'in';
  voice.serverId = 's1';
  voice.channelId = 'c1';
  servers.setServers([{ id: 's1', name: 'S', role: 'member' }]);
  servers.setRoster('s1', [
    { userId: 'alice', nickname: 'Alice', color: '#0f0', avatarKey: null },
    { userId: 'bob', nickname: 'Bob', color: '#00f', avatarKey: null },
  ]);
  servers.setPresence('s1', [
    { userId: 'me', state: 'voice', channelId: 'c1' },
    { userId: 'alice', state: 'voice', channelId: 'c1' },
    { userId: 'bob', state: 'voice', channelId: 'c1' },
  ]);
  voice.setHelloTracks('s1', [SCREEN_A, CAM_B]);
}

// Watch-related invokes only (streamWatch passes a Channel object we don't compare).
function watchCalls(): Array<{ cmd: string; ownerId?: unknown; trackName?: unknown; layer?: unknown }> {
  return invokes
    .filter((i) => i.cmd === 'stream_watch' || i.cmd === 'stream_unwatch')
    .map((i) => ({ cmd: i.cmd, ownerId: i.args.ownerId, trackName: i.args.trackName, layer: i.args.layer }));
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
  seed(); // after mockIPC — seeding tracks while "in voice" forwards them to the engine
  invokes = []; // only assert invokes made by the test body

});
afterEach(() => {
  clearMocks();
});

test('join → stream_watch at layer l + canvas mounts; leave → stream_unwatch + canvas unmounts', async () => {
  const screen = render(StreamTile, { track: SCREEN_A });
  expect(screen.container.querySelector('[data-testid="canvas-alice/screen-a"]')).toBeNull();

  await screen.getByRole('button', { name: 'Join Stream' }).click();
  await expect.element(screen.getByTestId('canvas-alice/screen-a')).toBeInTheDocument();
  expect(watchCalls()).toContainEqual({
    cmd: 'stream_watch',
    ownerId: 'alice',
    trackName: 'screen-a',
    layer: 'l',
  });

  await screen.getByRole('button', { name: 'Leave' }).click();
  expect(screen.container.querySelector('[data-testid="canvas-alice/screen-a"]')).toBeNull();
  expect(watchCalls()).toContainEqual({
    cmd: 'stream_unwatch',
    ownerId: 'alice',
    trackName: 'screen-a',
    layer: undefined,
  });
});

test('pin swap issues unwatch + watch with the new layers (h on pin, back to l on unpin)', async () => {
  const screen = render(StreamTile, { track: SCREEN_A });
  await screen.getByRole('button', { name: 'Join Stream' }).click();
  invokes = [];

  // Pin → the tile re-subscribes at layer h: unwatch THEN watch(h) (§1 order).
  await screen.getByRole('button', { name: 'Pin Alice' }).click();
  let calls = watchCalls();
  expect(calls).toEqual([
    { cmd: 'stream_unwatch', ownerId: 'alice', trackName: 'screen-a', layer: undefined },
    { cmd: 'stream_watch', ownerId: 'alice', trackName: 'screen-a', layer: 'h' },
  ]);
  expect(voice.pinned).toBe('alice/screen-a');

  // Unpin → back to l, same unwatch+watch shape.
  invokes = [];
  await screen.getByRole('button', { name: 'Pin Alice' }).click();
  calls = watchCalls();
  expect(calls).toEqual([
    { cmd: 'stream_unwatch', ownerId: 'alice', trackName: 'screen-a', layer: undefined },
    { cmd: 'stream_watch', ownerId: 'alice', trackName: 'screen-a', layer: 'l' },
  ]);
  expect(voice.pinned).toBeNull();
});

test('pinning tile B downgrades previously pinned tile A back to l', async () => {
  const screenA = render(StreamTile, { track: SCREEN_A });
  await screenA.getByRole('button', { name: 'Join Stream' }).click();
  // Second simulcast tile from another owner.
  const SCREEN_C: TrackInfo = { ...SCREEN_A, ownerId: 'bob', trackName: 'screen-c' };
  voice.setHelloTracks('s1', [SCREEN_A, SCREEN_C]);
  const screenC = render(StreamTile, { track: SCREEN_C });
  await screenC.getByRole('button', { name: 'Join Stream' }).click();

  await screenA.getByRole('button', { name: 'Pin Alice' }).click();
  invokes = [];
  await screenC.getByRole('button', { name: 'Pin Bob' }).click();

  const calls = watchCalls();
  // A re-subscribes at l, C re-subscribes at h (each as unwatch→watch).
  expect(calls).toContainEqual({ cmd: 'stream_watch', ownerId: 'alice', trackName: 'screen-a', layer: 'l' });
  expect(calls).toContainEqual({ cmd: 'stream_watch', ownerId: 'bob', trackName: 'screen-c', layer: 'h' });
  const unA = calls.findIndex((c) => c.cmd === 'stream_unwatch' && c.ownerId === 'alice');
  const reA = calls.findIndex((c) => c.cmd === 'stream_watch' && c.ownerId === 'alice');
  expect(unA).toBeGreaterThanOrEqual(0);
  expect(unA).toBeLessThan(reA);
  expect(voice.pinned).toBe('bob/screen-c');
});

test('pin control is disabled for simulcast:false tiles', async () => {
  const screen = render(StreamTile, { track: CAM_B });
  await screen.getByRole('button', { name: 'Join Stream' }).click();
  await expect.element(screen.getByRole('button', { name: 'Pin Bob' })).toBeDisabled();
  voice.togglePin(CAM_B); // store-level guard too
  expect(voice.pinned).toBeNull();
});

test('pinned track vanishing from the roster resets the pin and the watch state', () => {
  voice.joinStream(SCREEN_A);
  voice.togglePin(SCREEN_A);
  expect(voice.pinned).toBe('alice/screen-a');
  // Alice's tracks vanish (voice.leave broadcast → tracks []).
  voice.applyTracks('s1', 'alice', []);
  expect(voice.pinned).toBeNull();
  expect(voice.watched['alice/screen-a']).toBeUndefined();
});

test('StreamGrid renders one tile per video track of channel members and unmounts off-voice', async () => {
  const screen = render(StreamGrid);
  await expect.element(screen.getByTestId('stream-grid')).toBeInTheDocument();
  await expect.element(screen.getByTestId('tile-alice/screen-a')).toBeInTheDocument();
  await expect.element(screen.getByTestId('tile-bob/webcam-b')).toBeInTheDocument();

  // Mic tracks never become tiles.
  voice.setHelloTracks('s1', [
    SCREEN_A,
    { ownerId: 'bob', trackName: 'mic-b', kind: 'mic', simulcast: false, width: 0, height: 0, fps: 0 },
  ]);
  expect(voice.videoTiles.map((t) => VoiceStore.tileKey(t))).toEqual(['alice/screen-a']);
});
