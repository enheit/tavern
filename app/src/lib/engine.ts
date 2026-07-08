import { invoke } from '@tauri-apps/api/core';
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
};
