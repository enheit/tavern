import { SCREEN_PRESETS, WEBCAM_PRESET } from "@tavern/shared";
import type { ShareSelection } from "@/features/streams/types";
// captureScreen takes only a ShareSelection (S8.1), so it reads the platform singleton directly.
import { platform as platformBridge } from "@/platform/types";
import type { NoiseSuppressionMode } from "@/stores/settings";
import { useSettingsStore } from "@/stores/settings";
import { applyNoiseWorklet } from "./noiseWorklet";

// Capture acquisition (PLAN §7.2). This module + ports.ts are the only app files permitted to call
// getUserMedia / getDisplayMedia (DoD grep gate).

interface MicOpts {
  deviceId?: string;
  noiseSuppression: NoiseSuppressionMode;
  // Shared app AudioContext (§7.3) hosting the WASM worklet modes. When absent (unit tests, graph
  // not initialized) the worklet modes degrade to raw capture — never a second AudioContext here.
  audioContext?: AudioContext;
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

// FR-22 voice capture matrix (Task-2 quality stack): echoCancellation is ALWAYS on (off + speakers
// = feedback); "standard" drives Chromium's noiseSuppression; the WASM modes ("rnnoise"/
// "deepfilter") turn browser NS OFF so the model sees the unprocessed signal (double suppression =
// artifacts). autoGainControl is OFF for EVERY mode: Chromium's AGC pumps speech levels and drags
// quiet-room gain up between words (the FR-28 monitor probe even measured it dragging a device
// volume down persistently) — a fixed input level with the suppressor's own leveling sounds
// closer to Discord. Capture is 48 kHz mono for all modes: Opus encodes voice mono at 48 kHz and
// the worklet models are mono 48 kHz — stereo/44.1k capture just costs a resample+downmix.
// §10 e2e seam: the harness's fake mic is a STEADY 440 Hz sine (tone WAV), and Chromium's audio
// processing treats a stationary tone as noise — NS/AEC adapt it to near-silence within seconds
// (measured: RMS 0.36 raw → 0.04 at 3 s and falling), which zeroes the remote audioLevel the
// @realtime suite asserts. Under the harness all processing is off; real users are unaffected.
function micConstraints(opts: MicOpts): MediaTrackConstraints {
  if (platformBridge.isE2E) {
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
    };
  }
  return {
    echoCancellation: true,
    noiseSuppression: opts.noiseSuppression === "standard",
    autoGainControl: false,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
  };
}

export async function getMic(opts: MicOpts): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(opts) });
  const raw = firstAudioTrack(stream);
  // §10: the worklet pipeline never runs under the e2e harness — the sine seam must stay raw.
  if (platformBridge.isE2E || !opts.audioContext) return raw;
  if (opts.noiseSuppression !== "rnnoise" && opts.noiseSuppression !== "deepfilter") return raw;
  return applyNoiseWorklet(opts.audioContext, raw, opts.noiseSuppression);
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

// FR-28 system-audio fallback (web + desktop Linux). Chromium on Linux offers display-capture
// audio for TAB shares only — a screen/window share resolves with NO audio track even when
// requested (Firefox: never any display audio). PulseAudio/pipewire-pulse expose every output as
// a "Monitor of …" audioinput, so when the display picker yields silence we capture that monitor
// directly. echoCancellation:true is the anti-loopback: Chromium's AEC reference is the browser's
// own playout, so Tavern voices/soundboard are cancelled OUT of the monitor signal while game/app
// audio (not Chromium playout) passes — venmic-style self-exclusion without a native module.
// NS/AGC stay off: this is content audio, not speech.
export const SYSTEM_AUDIO_AUTO = "auto";
export const SYSTEM_AUDIO_OFF = "off";

// The label the desktop Linux main process gives its pactl remap-source (capture.ts there) — the
// auto-pick prefers it over any other monitor-ish input so a user's own virtual devices never
// shadow the one Tavern just created for this share. Spaceless because pipewire-pulse's
// remap-source truncates multi-word descriptions (see desktop/src/main/capture.ts).
export const TAVERN_STREAM_AUDIO_LABEL = "TavernStreamMonitor";

// venmic's virtual mic node (desktop Linux + PipeWire, Task-3 — name hardcoded upstream, mirrored
// by desktop/src/main/venmic.ts VENMIC_NODE_NAME). Outranks the remap source: when the main
// process linked it, the capture is already voice-free at the PipeWire level (Tavern's audio
// service excluded by PID), which beats AEC-based self-exclusion on content fidelity.
export const VENMIC_STREAM_AUDIO_LABEL = "vencord-screen-share";

// Resolves the fallback capture device: an explicit deviceId when the user picked one in Voice
// settings, else the venmic virtual mic (desktop Linux, when the main process linked one), else
// Tavern's own remap-source, else the first monitor-labeled input (Firefox lists pulse monitors
// directly; Chromium only ever shows virtual/remapped sources). Labels are pulse DESCRIPTIONS
// ("Monitor of Built-in Audio…") — a localized description the /monitor/i heuristic misses is
// what the explicit settings pick is for. Null = nothing suitable (share goes video-only).
export function pickSystemAudioDevice(
  devices: MediaDeviceInfo[],
  explicitId: string | null,
): MediaDeviceInfo | null {
  const inputs = devices.filter((d) => d.kind === "audioinput");
  if (explicitId !== null) return inputs.find((d) => d.deviceId === explicitId) ?? null;
  return (
    inputs.find((d) => d.label === VENMIC_STREAM_AUDIO_LABEL) ??
    inputs.find((d) => d.label === TAVERN_STREAM_AUDIO_LABEL) ??
    inputs.find((d) => /monitor/i.test(d.label)) ??
    null
  );
}

async function captureSystemAudio(explicitId: string | null): Promise<MediaStreamTrack | null> {
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return null;
  }
  const device = pickSystemAudioDevice(devices, explicitId);
  if (device === null) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: device.deviceId },
        // Self-exclusion — cancels the app's own playout from a monitor capture. The venmic node
        // is ALREADY voice-free at the PipeWire level (per-PID exclusion), so AEC there would only
        // duck game/music during double-talk for no benefit.
        echoCancellation: device.label !== VENMIC_STREAM_AUDIO_LABEL,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    return firstAudioTrack(stream);
  } catch {
    // Device raced away / permission denied — the share still starts, video-only.
    return null;
  }
}

// Where a share's audio track came from — drives which self-audio note the controller shows.
// "display" = the browser picker granted it (tab audio, or win/mac loopback via the desktop
// handler); "monitor" = the FR-28 fallback captured an OS monitor/loopback input.
export type ShareAudioSource = "display" | "monitor";

export interface ScreenCapture {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  audioSource: ShareAudioSource | null;
  // Display audio from a TAB share carries only that tab — no self-audio caveat applies.
  tabAudio: boolean;
}

// The fallback never runs for a TAB share: the browser offered tab audio natively there, so a
// missing track means the user declined audio — capturing the whole system monitor instead would
// override that choice. displaySurface is unset on Electron desktopCapturer tracks → treated as
// non-tab, which is right (desktop shares are screens/windows). Guarded call: unit-test doubles
// (and any engine without the setting) simply read as non-tab.
function isTabSurface(video: MediaStreamTrack): boolean {
  return typeof video.getSettings === "function"
    ? video.getSettings().displaySurface === "browser"
    : false;
}

// FR-27/FR-28 screen capture. Desktop: arm the main-process display-media handler with the picked
// source (§6.3 selectSource), then getDisplayMedia. Web: getDisplayMedia directly (the browser's
// native picker chooses the source). Only ideal/max constraint keys — min/exact throw on display
// capture (PLAN §7.2). `withAudio` requests system/loopback (desktop) or tab (web) audio; where
// the display request can't deliver it (Linux, Firefox), the system-audio fallback above kicks in.
export async function captureScreen(sel: ShareSelection): Promise<ScreenCapture> {
  const spec = SCREEN_PRESETS[sel.preset];
  if (platformBridge.kind === "desktop") await platformBridge.capture.selectSource(sel.sourceId);
  const pref = useSettingsStore.getState().deviceSettings.streamAudio ?? SYSTEM_AUDIO_AUTO;
  const explicitId = pref === SYSTEM_AUDIO_AUTO || pref === SYSTEM_AUDIO_OFF ? null : pref;
  const desktopLinux = platformBridge.kind === "desktop" && platformBridge.os === "linux";
  // The display request carries audio only when the fallback isn't taking over: an explicit
  // fallback device wins over display audio (the user picked the source), and desktop Linux has no
  // loopback device for the handler to attach — there audio is the fallback's job entirely.
  const wantDisplayAudio = sel.withAudio && explicitId === null && !desktopLinux;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: spec.width, max: spec.width },
      height: { ideal: spec.height, max: spec.height },
      frameRate: { ideal: spec.fps, max: spec.fps },
    },
    audio: wantDisplayAudio,
  });
  const video = firstVideoTrack(stream);
  let audio = stream.getAudioTracks()[0] ?? null;
  let audioSource: ShareAudioSource | null = audio === null ? null : "display";
  const fallbackEligible =
    sel.withAudio &&
    audio === null &&
    pref !== SYSTEM_AUDIO_OFF &&
    (platformBridge.kind === "web" || desktopLinux) &&
    !isTabSurface(video) &&
    // §10 hermeticity: auto-mode would race the harness's fake devices; e2e opts in with an
    // explicit deviceId written to settings before the share starts.
    (explicitId !== null || !platformBridge.isE2E);
  if (fallbackEligible) {
    audio = await captureSystemAudio(explicitId);
    audioSource = audio === null ? null : "monitor";
  }
  return { video, audio, audioSource, tabAudio: audioSource === "display" && isTabSurface(video) };
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
