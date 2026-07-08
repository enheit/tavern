import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import ShareDialog from './ShareDialog.svelte';
import VoicePanel from '../VoicePanel.svelte';
import { voice } from '../../state/voice.svelte';
import { auth } from '../../state/auth.svelte';
import { servers } from '../../state/servers.svelte';
import type { TrackInfo } from '../../protocol/TrackInfo';

// S5.3 DoD: picker→screen_share_start payload mapping (≥6 res/fps combos incl.
// native→0×0), stop mapping, and the 3-share disable state from a roster fixture.

let invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];

const SOURCES = [
  { id: 'screen:primary', name: 'Primary Display', kind: 'screen' },
  { id: 'window:42', name: 'Terminal', kind: 'window' },
  { id: 'window:7', name: 'Browser', kind: 'window' },
];

function seedInVoice(): void {
  voice.status = 'in';
  voice.serverId = 's1';
  voice.channelId = 'c1';
  servers.setServers([{ id: 's1', name: 'S', role: 'member' }]);
  servers.setChannels('s1', [
    { id: 'c1', name: 'VC', kind: 'voice', hasPassword: false, unlocked: true },
  ]);
  servers.setPresence('s1', [{ userId: 'me', state: 'voice', channelId: 'c1' }]);
}

function screenTrack(ownerId: string, n: number): TrackInfo {
  return {
    ownerId,
    trackName: `screen-${ownerId}-${n}`,
    kind: 'screen',
    simulcast: true,
    width: 1280,
    height: 720,
    fps: 30,
  };
}

beforeEach(() => {
  invokes = [];
  auth.reset();
  servers.reset();
  voice.reset();
  localStorage.clear();
  auth.setSession('me', 'tok', { userId: 'me', nickname: 'Me', color: '#8a8f98', avatarKey: null });
  voice.sendFrame = () => {};
  seedInVoice();
  mockIPC((cmd, args) => {
    invokes.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === 'screen_sources') return SOURCES;
    if (cmd === 'screen_share_start') return { trackName: 'screen-me-live' };
    return null;
  });
});
afterEach(() => {
  clearMocks();
});

async function selectValue(screen: ReturnType<typeof render>, label: string, value: string) {
  const el = screen.getByLabelText(label);
  await el.selectOptions(value);
}

test('picker lists screens and windows from screen_sources', async () => {
  const screen = render(ShareDialog, { onclose: () => {} });
  await expect.element(screen.getByRole('option', { name: 'Primary Display' })).toBeInTheDocument();
  await expect.element(screen.getByRole('option', { name: 'Terminal' })).toBeInTheDocument();
  await expect.element(screen.getByRole('option', { name: 'Browser' })).toBeInTheDocument();
  expect(invokes.map((i) => i.cmd)).toContain('screen_sources');
});

// DoD: ≥6 res/fps combos, incl. native→0×0. The payload carries the picked source id.
const COMBOS: Array<[string, number, number, number]> = [
  // [resolution option, fps, expected width, expected height]
  ['native', 30, 0, 0],
  ['native', 120, 0, 0],
  ['360', 15, 640, 360],
  ['480', 30, 854, 480],
  ['720', 60, 1280, 720],
  ['1080', 60, 1920, 1080],
  ['1440', 120, 2560, 1440],
];
for (const [res, fps, width, height] of COMBOS) {
  test(`start maps ${res}@${fps} → screen_share_start(${width}x${height}, ${fps})`, async () => {
    const screen = render(ShareDialog, { onclose: () => {} });
    await expect.element(screen.getByRole('option', { name: 'Terminal' })).toBeInTheDocument();
    await selectValue(screen, 'Source', 'window:42');
    await selectValue(screen, 'Resolution', res);
    await selectValue(screen, 'Frame rate', String(fps));
    await screen.getByTestId('share-start').click();
    expect(invokes).toContainEqual({
      cmd: 'screen_share_start',
      args: { sourceId: 'window:42', width, height, fps },
    });
  });
}

test('successful start closes the dialog and marks sharing', async () => {
  let closed = false;
  const screen = render(ShareDialog, { onclose: () => (closed = true) });
  await expect.element(screen.getByRole('option', { name: 'Primary Display' })).toBeInTheDocument();
  await screen.getByTestId('share-start').click();
  expect(voice.sharing).toEqual({ trackName: 'screen-me-live' });
  expect(closed).toBe(true);
});

test('3 screen tracks in the channel disable Start (roster fixture)', async () => {
  servers.setPresence('s1', [
    { userId: 'me', state: 'voice', channelId: 'c1' },
    { userId: 'a', state: 'voice', channelId: 'c1' },
    { userId: 'b', state: 'voice', channelId: 'c1' },
    { userId: 'c', state: 'voice', channelId: 'c1' },
  ]);
  voice.setHelloTracks('s1', [screenTrack('a', 1), screenTrack('b', 1), screenTrack('c', 1)]);
  expect(voice.screenTrackCount).toBe(3);

  const screen = render(ShareDialog, { onclose: () => {} });
  await expect.element(screen.getByTestId('share-start')).toBeDisabled();
  await expect.element(screen.getByRole('alert')).toBeInTheDocument();
});

test('screen tracks in ANOTHER channel do not count toward the cap', async () => {
  servers.setPresence('s1', [
    { userId: 'me', state: 'voice', channelId: 'c1' },
    { userId: 'a', state: 'voice', channelId: 'other-vc' },
    { userId: 'b', state: 'voice', channelId: 'other-vc' },
    { userId: 'c', state: 'voice', channelId: 'other-vc' },
  ]);
  voice.setHelloTracks('s1', [screenTrack('a', 1), screenTrack('b', 1), screenTrack('c', 1)]);
  expect(voice.screenTrackCount).toBe(0);
  expect(voice.shareDisabled).toBe(false);
});

test('VoicePanel: Share button opens the picker; disabled at the cap with a tooltip', async () => {
  const screen = render(VoicePanel);
  const share = screen.getByRole('button', { name: 'Share screen' });
  await expect.element(share).not.toBeDisabled();
  await share.click();
  await expect.element(screen.getByRole('option', { name: 'Primary Display' })).toBeInTheDocument();

  // Now trip the cap: button must disable (fresh render — dialog already open here).
  servers.setPresence('s1', [
    { userId: 'me', state: 'voice', channelId: 'c1' },
    { userId: 'a', state: 'voice', channelId: 'c1' },
    { userId: 'b', state: 'voice', channelId: 'c1' },
    { userId: 'c', state: 'voice', channelId: 'c1' },
  ]);
  voice.setHelloTracks('s1', [screenTrack('a', 1), screenTrack('b', 1), screenTrack('c', 1)]);
  await expect.element(screen.getByTestId('share-start')).toBeDisabled();
});

test('VoicePanel: sharing indicator + Stop maps to screen_share_stop', async () => {
  voice.sharing = { trackName: 'screen-me-live' };
  const screen = render(VoicePanel);
  await expect.element(screen.getByTestId('sharing-indicator')).toBeInTheDocument();

  await screen.getByRole('button', { name: 'Stop sharing' }).click();
  expect(invokes).toContainEqual({ cmd: 'screen_share_stop', args: {} });
  expect(voice.sharing).toBeNull();
  await expect.element(screen.getByRole('button', { name: 'Share screen' })).toBeInTheDocument();
});

test('shareStart failure surfaces as the panel error toast', async () => {
  clearMocks();
  mockIPC((cmd) => {
    if (cmd === 'screen_sources') return SOURCES;
    if (cmd === 'screen_share_start') throw new Error('signaling http 409 (share_limit)');
    return null;
  });
  await voice.shareStart('screen:primary', 0, 0, 30);
  expect(voice.sharing).toBeNull();
  expect(voice.error).toContain('share_limit');
});
