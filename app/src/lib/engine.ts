import { Channel, invoke } from '@tauri-apps/api/core';
import type { TrackInfo } from './protocol/TrackInfo';
import { webEngine } from './engine.web';

export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Frontend wrappers for the §1 engine commands (voice subset, S4.2). Inside the
// Tauri webview they invoke the Rust engine; in a browser (S7 web build) the same
// surface is served by engine.web.ts on browser WebRTC. Callers never branch.
export const engine = {
  async voiceJoin(channelId: string): Promise<{ trackName: string } | null> {
    if (!inTauri()) return webEngine.voiceJoin(channelId);
    return await invoke<{ trackName: string }>('voice_join', { channelId });
  },
  async voiceLeave(): Promise<void> {
    if (inTauri()) await invoke('voice_leave');
    else await webEngine.voiceLeave();
  },
  async setMicMuted(muted: boolean): Promise<void> {
    if (inTauri()) await invoke('set_mic_muted', { muted });
    else webEngine.setMicMuted(muted);
  },
  async setDeafened(deafened: boolean): Promise<void> {
    if (inTauri()) await invoke('set_deafened', { deafened });
    else webEngine.setDeafened(deafened);
  },
  async setUserGain(userId: string, gain: number): Promise<void> {
    if (inTauri()) await invoke('set_user_gain', { userId, gain });
    else webEngine.setUserGain(userId, gain);
  },
  async setRemoteTracks(tracks: TrackInfo[]): Promise<void> {
    if (inTauri()) await invoke('set_remote_tracks', { tracks });
    else webEngine.setRemoteTracks(tracks);
  },
  async screenSources(): Promise<ScreenSource[]> {
    if (!inTauri()) return webEngine.screenSources();
    return await invoke<ScreenSource[]>('screen_sources');
  },
  async screenShareStart(
    sourceId: string,
    width: number,
    height: number,
    fps: number,
  ): Promise<{ trackName: string } | null> {
    if (!inTauri()) return webEngine.screenShareStart(sourceId, width, height, fps);
    return await invoke<{ trackName: string }>('screen_share_start', {
      sourceId,
      width,
      height,
      fps,
    });
  },
  async screenShareStop(): Promise<void> {
    if (inTauri()) await invoke('screen_share_stop');
    else await webEngine.screenShareStop();
  },
  // §1: the UI creates the Channel and passes it in the invoke; each message is one
  // §1-framed chunk ({u32 len | u8 keyframe | u64 ptsMs | bytes}) as an ArrayBuffer.
  // The web engine skips chunks entirely — StreamTile renders streamMedia() instead.
  async streamWatch(
    ownerId: string,
    trackName: string,
    layer: 'l' | 'h',
    onChunk: (buf: ArrayBuffer) => void,
  ): Promise<void> {
    if (!inTauri()) return webEngine.streamWatch(ownerId, trackName, layer);
    const frames = new Channel<ArrayBuffer>();
    frames.onmessage = onChunk;
    await invoke('stream_watch', { ownerId, trackName, layer, frames });
  },
  async streamUnwatch(ownerId: string, trackName: string): Promise<void> {
    if (inTauri()) await invoke('stream_unwatch', { ownerId, trackName });
    else await webEngine.streamUnwatch(ownerId, trackName);
  },
  /** Web build only: the live MediaStream behind a watched tile (null in Tauri). */
  streamMedia(ownerId: string, trackName: string): MediaStream | null {
    return inTauri() ? null : webEngine.streamMedia(ownerId, trackName);
  },
  async webcamList(): Promise<WebcamDevice[]> {
    if (!inTauri()) return webEngine.webcamList();
    return await invoke<WebcamDevice[]>('webcam_list');
  },
  async webcamStart(
    deviceId: string,
    width: number,
    height: number,
    fps: number,
  ): Promise<{ trackName: string } | null> {
    if (!inTauri()) return webEngine.webcamStart(deviceId, width, height, fps);
    return await invoke<{ trackName: string }>('webcam_start', { deviceId, width, height, fps });
  },
  async webcamStop(): Promise<void> {
    if (inTauri()) await invoke('webcam_stop');
    else await webEngine.webcamStop();
  },
  // S6.3 boot probes.
  async setWebcodecsOk(ok: boolean): Promise<void> {
    if (inTauri()) await invoke('set_webcodecs_ok', { ok });
  },
  /// null = capture available; string = the typed error (Linux portal/PipeWire).
  async captureProbe(): Promise<string | null> {
    if (!inTauri()) return null;
    try {
      await invoke('capture_probe');
      return null;
    } catch (e) {
      return String(e);
    }
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
