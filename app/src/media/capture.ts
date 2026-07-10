import type { PresetId } from "@tavern/shared";
import { SCREEN_PRESETS, WEBCAM_PRESET } from "@tavern/shared";
import type { ShareSelection } from "@/features/streams/types";
// The captureScreen signature (S8.1) takes only a ShareSelection, so it reads the platform singleton
// directly (aliased to avoid shadowing getScreen's `platform` parameter). getScreen keeps DI.
import { platform as platformBridge } from "@/platform/types";
import type { PlatformBridge } from "@/platform/types";

// Capture acquisition (PLAN §7.2). This module + ports.ts are the only app files permitted to call
// getUserMedia / getDisplayMedia (DoD grep gate).

interface MicOpts {
  deviceId?: string;
  noiseSuppression: boolean;
}

function firstAudioTrack(stream: MediaStream): MediaStreamTrack {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("no audio track in stream");
  return track;
}

function firstVideoTrack(stream: MediaStream): MediaStreamTrack {
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("no video track in stream");
  return track;
}

// echoCancellation is ALWAYS on (off + speakers = feedback); the single FR-22 toggle drives
// noiseSuppression + autoGainControl together.
function micConstraints(opts: MicOpts): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: opts.noiseSuppression,
    autoGainControl: opts.noiseSuppression,
    ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
  };
}

export async function getMic(opts: MicOpts): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(opts) });
  return firstAudioTrack(stream);
}

// FR-22 retoggle: applyConstraints is a Chromium WontFix no-op for these (crbug 327472528), so
// stop the mic → re-acquire with the new constraints → replaceTrack. The call never renegotiates.
export async function retoggleMic(
  current: MediaStreamTrack,
  sender: RTCRtpSender,
  opts: MicOpts,
): Promise<MediaStreamTrack> {
  current.stop();
  const next = await getMic(opts);
  await sender.replaceTrack(next);
  return next;
}

// getDisplayMedia constraints are downscale-only ceilings — only ideal/max are legal (min/exact
// throw TypeError). Loopback (stream) audio is captured only where the OS supports it (FR-28).
export async function getScreen(
  platform: PlatformBridge,
  preset: PresetId,
  wantAudio: boolean,
): Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null }> {
  const spec = SCREEN_PRESETS[preset];
  const withLoopback = wantAudio ? await platform.capture.loopbackAudioSupported() : false;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: spec.width, max: spec.width },
      height: { ideal: spec.height, max: spec.height },
      frameRate: { ideal: spec.fps, max: spec.fps },
    },
    audio: withLoopback,
  });
  return { video: firstVideoTrack(stream), audio: stream.getAudioTracks()[0] ?? null };
}

// FR-27/FR-28 screen capture. Desktop: arm the main-process display-media handler with the picked
// source (§6.3 selectSource), then getDisplayMedia. Web: getDisplayMedia directly (the browser's
// native picker chooses the source). Only ideal/max constraint keys — min/exact throw on display
// capture (PLAN §7.2). `withAudio` requests system/loopback (desktop) or tab (web) audio; the
// SharePickerDialog only sets it true where the OS supports it, so no probe is needed here.
export async function captureScreen(
  sel: ShareSelection,
): Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null }> {
  const spec = SCREEN_PRESETS[sel.preset];
  if (platformBridge.kind === "desktop") await platformBridge.capture.selectSource(sel.sourceId);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: spec.width, max: spec.width },
      height: { ideal: spec.height, max: spec.height },
      frameRate: { ideal: spec.fps, max: spec.fps },
    },
    audio: sel.withAudio,
  });
  return { video: firstVideoTrack(stream), audio: stream.getAudioTracks()[0] ?? null };
}

// Webcam is fixed 720p30 (App-D); the h/l simulcast split is applied by the PublishSession.
export async function getCam(deviceId?: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: WEBCAM_PRESET.width },
      height: { ideal: WEBCAM_PRESET.height },
      frameRate: { ideal: WEBCAM_PRESET.fps },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  });
  return firstVideoTrack(stream);
}
