import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import WebcamDialog from './WebcamDialog.svelte';
import VoicePanel from '../VoicePanel.svelte';
import { voice } from '../../state/voice.svelte';
import { auth } from '../../state/auth.svelte';
import { servers } from '../../state/servers.svelte';

// S5.5 DoD: picker→webcam_start command mapping for ALL 6 §0 combos (360/480/720 ×
// 15/30), plus on/off indicator + stop mapping.

let invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];

const CAMS = [
  { id: '0', name: 'FaceTime HD' },
  { id: '1', name: 'External Cam' },
];

beforeEach(() => {
  invokes = [];
  auth.reset();
  servers.reset();
  voice.reset();
  localStorage.clear();
  auth.setSession('me', 'tok', { userId: 'me', nickname: 'Me', color: '#8a8f98', avatarKey: null });
  voice.sendFrame = () => {};
  voice.status = 'in';
  voice.serverId = 's1';
  voice.channelId = 'c1';
  servers.setServers([{ id: 's1', name: 'S', role: 'member' }]);
  mockIPC((cmd, args) => {
    invokes.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === 'webcam_list') return CAMS;
    if (cmd === 'webcam_start') return { trackName: 'webcam-me-live' };
    return null;
  });
});
afterEach(() => {
  clearMocks();
});

// DoD: all 6 §0 combos → exact webcam_start payloads (480 is the 4:3 camera mode).
const COMBOS: Array<[string, number, number, number]> = [
  ['360', 15, 640, 360],
  ['360', 30, 640, 360],
  ['480', 15, 640, 480],
  ['480', 30, 640, 480],
  ['720', 15, 1280, 720],
  ['720', 30, 1280, 720],
];
for (const [res, fps, width, height] of COMBOS) {
  test(`picker maps ${res}p@${fps} → webcam_start(${width}x${height}, ${fps})`, async () => {
    const screen = render(WebcamDialog, { onclose: () => {} });
    await expect.element(screen.getByRole('option', { name: 'External Cam' })).toBeInTheDocument();
    await screen.getByLabelText('Camera').selectOptions('1');
    await screen.getByLabelText('Webcam resolution').selectOptions(res);
    await screen.getByLabelText('Webcam frame rate').selectOptions(String(fps));
    await screen.getByTestId('cam-start').click();
    expect(invokes).toContainEqual({
      cmd: 'webcam_start',
      args: { deviceId: '1', width, height, fps },
    });
    expect(voice.camera).toEqual({ trackName: 'webcam-me-live' });
  });
}

test('VoicePanel: webcam indicator + Turn off maps to webcam_stop', async () => {
  voice.camera = { trackName: 'webcam-me-live' };
  const screen = render(VoicePanel);
  await expect.element(screen.getByTestId('camera-indicator')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Turn off webcam' }).click();
  expect(invokes).toContainEqual({ cmd: 'webcam_stop', args: {} });
  expect(voice.camera).toBeNull();
  await expect.element(screen.getByRole('button', { name: 'Webcam' })).toBeInTheDocument();
});

test('webcam start failure surfaces as the panel toast', async () => {
  clearMocks();
  mockIPC((cmd) => {
    if (cmd === 'webcam_list') return CAMS;
    if (cmd === 'webcam_start') throw new Error('capture: permission denied: camera');
    return null;
  });
  await voice.camStart('0', 1280, 720, 30);
  expect(voice.camera).toBeNull();
  expect(voice.error).toContain('permission denied');
});
