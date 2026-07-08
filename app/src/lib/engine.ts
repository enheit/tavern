import { Channel, invoke } from '@tauri-apps/api/core';
import type { TrackInfo } from './protocol/TrackInfo';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Frontend wrappers for the §1 engine commands (voice subset, S4.2). No-ops outside
// the Tauri webview (browser dev / tests without mockIPC) so nothing throws there.
export const engine = {
  async voiceJoin(channelId: string): Promise<{ trackName: string } | null> {
    if (!inTauri()) return null;
    return await invoke<{ trackName: string }>('voice_join', { channelId });
  },
  async voiceLeave(): Promise<void> {
    if (inTauri()) await invoke('voice_leave');
  },
  async setMicMuted(muted: boolean): Promise<void> {
    if (inTauri()) await invoke('set_mic_muted', { muted });
  },
  async setDeafened(deafened: boolean): Promise<void> {
    if (inTauri()) await invoke('set_deafened', { deafened });
  },
  async setUserGain(userId: string, gain: number): Promise<void> {
    if (inTauri()) await invoke('set_user_gain', { userId, gain });
  },
  async setRemoteTracks(tracks: TrackInfo[]): Promise<void> {
    if (inTauri()) await invoke('set_remote_tracks', { tracks });
  },
  async screenSources(): Promise<ScreenSource[]> {
    if (!inTauri()) return [];
    return await invoke<ScreenSource[]>('screen_sources');
  },
  async screenShareStart(
    sourceId: string,
    width: number,
    height: number,
    fps: number,
  ): Promise<{ trackName: string } | null> {
    if (!inTauri()) return null;
    return await invoke<{ trackName: string }>('screen_share_start', {
      sourceId,
      width,
      height,
      fps,
    });
  },
  async screenShareStop(): Promise<void> {
    if (inTauri()) await invoke('screen_share_stop');
  },
  // §1: the UI creates the Channel and passes it in the invoke; each message is one
  // §1-framed chunk ({u32 len | u8 keyframe | u64 ptsMs | bytes}) as an ArrayBuffer.
  async streamWatch(
    ownerId: string,
    trackName: string,
    layer: 'l' | 'h',
    onChunk: (buf: ArrayBuffer) => void,
  ): Promise<void> {
    if (!inTauri()) return;
    const frames = new Channel<ArrayBuffer>();
    frames.onmessage = onChunk;
    await invoke('stream_watch', { ownerId, trackName, layer, frames });
  },
  async streamUnwatch(ownerId: string, trackName: string): Promise<void> {
    if (inTauri()) await invoke('stream_unwatch', { ownerId, trackName });
  },
  async webcamList(): Promise<WebcamDevice[]> {
    if (!inTauri()) return [];
    return await invoke<WebcamDevice[]>('webcam_list');
  },
  async webcamStart(
    deviceId: string,
    width: number,
    height: number,
    fps: number,
  ): Promise<{ trackName: string } | null> {
    if (!inTauri()) return null;
    return await invoke<{ trackName: string }>('webcam_start', { deviceId, width, height, fps });
  },
  async webcamStop(): Promise<void> {
    if (inTauri()) await invoke('webcam_stop');
  },
};

export interface WebcamDevice {
  id: string;
  name: string;
}

export interface ScreenSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
}
