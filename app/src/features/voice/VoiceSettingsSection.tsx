import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { getWebcamController } from "@/features/streams/useWebcam";
import { SYSTEM_AUDIO_AUTO, SYSTEM_AUDIO_OFF } from "@/media/capture";
import { setDeepfilterAtten } from "@/media/noiseWorklet";
import { m } from "@/paraglide/messages.js";
import { platform } from "@/platform/types";
import { useMediaStore } from "@/stores/media";
import {
  DEEPFILTER_ATTEN_DEFAULT,
  DEEPFILTER_ATTEN_MAX,
  DEEPFILTER_ATTEN_MIN,
  type DeviceSettingsV1,
  isNoiseSuppressionMode,
  type NoiseSuppressionMode,
  useSettingsStore,
} from "@/stores/settings";
import { getVoiceController } from "./voiceController";

// FR-21/22 Voice settings tab: input/output device pickers + noise-suppression toggle. Device labels
// require mic permission (enumerateDevices returns blank labels otherwise, MDN). Changing input or
// noise mid-call retoggles the mic (stop→reacquire→replaceTrack); changing output calls graph.setSink.
// FR-22 noise-suppression modes surfaced in settings. "standard" = Chromium NS/AGC constraints;
// "deepfilter" = the DeepFilterNet3 WASM AudioWorklet model, on-device (see media/noiseWorklet.ts),
// with a live strength/AGC panel below; "off" = AEC only.
const NOISE_OPTIONS: Array<{
  value: NoiseSuppressionMode;
  label: () => string;
  hint: () => string;
}> = [
  { value: "off", label: m.settings_voice_noise_off, hint: m.settings_voice_noise_off_hint },
  {
    value: "standard",
    label: m.settings_voice_noise_standard,
    hint: m.settings_voice_noise_standard_hint,
  },
  {
    value: "deepfilter",
    label: m.settings_voice_noise_deepfilter,
    hint: m.settings_voice_noise_deepfilter_hint,
  },
];

function toItems(devices: MediaDeviceInfo[]): Record<string, string> {
  const items: Record<string, string> = {};
  for (const d of devices) items[d.deviceId] = d.label || d.deviceId;
  return items;
}

// Persist device settings without any mic re-acquire — used for the DeepFilterNet strength, which
// retunes the running worklet via a postMessage (setDeepfilterAtten), so a retoggle would only add
// a needless gap.
function persistDeviceSettingsOnly(next: DeviceSettingsV1): void {
  useSettingsStore.getState().setDeviceSettings(next);
  useMediaStore.getState().setDeviceSelection(next);
}

export function VoiceSettingsSection() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const deviceSettings = useSettingsStore((s) => s.deviceSettings);
  const inVoice = useMediaStore((s) => s.inVoiceServerId !== null);
  // Local mirror of the DeepFilterNet strength so dragging the slider stays smooth — we retune the
  // live worklet on every change (gapless) and only persist on commit.
  const [atten, setAtten] = useState(deviceSettings.deepfilterAtten ?? DEEPFILTER_ATTEN_DEFAULT);
  useEffect(() => {
    setAtten(deviceSettings.deepfilterAtten ?? DEEPFILTER_ATTEN_DEFAULT);
  }, [deviceSettings.deepfilterAtten]);

  useEffect(() => {
    let cancelled = false;
    const md = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    void md
      .enumerateDevices()
      .then((devices) => {
        if (cancelled) return;
        setInputs(devices.filter((d) => d.kind === "audioinput"));
        setOutputs(devices.filter((d) => d.kind === "audiooutput"));
        setCameras(devices.filter((d) => d.kind === "videoinput"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = (next: DeviceSettingsV1, sink: boolean): void => {
    useSettingsStore.getState().setDeviceSettings(next);
    useMediaStore.getState().setDeviceSelection(next);
    if (!inVoice) return;
    const controller = getVoiceController();
    if (sink) {
      if (next.sinkId !== undefined) void controller.setSink(next.sinkId);
    } else {
      void controller.retoggleMic();
    }
  };

  const oneValue = (v: number | readonly number[]): number =>
    Array.isArray(v) ? (v[0] ?? atten) : (v as number);

  // FR-29 camera switch: persist the selection, then — if the webcam is publishing — swap the camera
  // mid-publish (stop → getCam → replaceTrack, no renegotiation). Idle → the next start uses the new id.
  const applyCamera = (cameraDeviceId: string): void => {
    const next = { ...deviceSettings, cameraDeviceId };
    useSettingsStore.getState().setDeviceSettings(next);
    useMediaStore.getState().setDeviceSelection(next);
    void getWebcamController().switchDevice(cameraDeviceId);
  };

  // FR-28 stream-audio source (web + desktop Linux, where display capture has no system audio of
  // its own): persist only — the next share start reads it. No live retoggle of anything.
  const streamAudioVisible = platform.kind === "web" || platform.os === "linux";
  const applyStreamAudio = (streamAudio: string): void => {
    const next = { ...deviceSettings, streamAudio };
    useSettingsStore.getState().setDeviceSettings(next);
    useMediaStore.getState().setDeviceSelection(next);
  };
  const streamAudioItems: Record<string, string> = {
    [SYSTEM_AUDIO_AUTO]: m.settings_voice_stream_audio_auto(),
    [SYSTEM_AUDIO_OFF]: m.settings_voice_stream_audio_off(),
    ...toItems(inputs),
  };

  return (
    <div data-testid="settings-voice" className="flex flex-col gap-5 py-2">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{m.settings_voice_input()}</span>
        <Select
          value={deviceSettings.micId ?? ""}
          items={toItems(inputs)}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            apply({ ...deviceSettings, micId: value }, false);
          }}
        >
          <SelectTrigger data-testid="settings-voice-input" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {inputs.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId} data-testid={`input-${d.deviceId}`}>
                {d.label || d.deviceId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{m.settings_voice_output()}</span>
        <Select
          value={deviceSettings.sinkId ?? ""}
          items={toItems(outputs)}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            apply({ ...deviceSettings, sinkId: value }, true);
          }}
        >
          <SelectTrigger data-testid="settings-voice-output" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {outputs.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId} data-testid={`output-${d.deviceId}`}>
                {d.label || d.deviceId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{m.settings_voice_camera()}</span>
        <Select
          value={deviceSettings.cameraDeviceId ?? ""}
          items={toItems(cameras)}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            applyCamera(value);
          }}
        >
          <SelectTrigger data-testid="settings-voice-camera" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {cameras.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId} data-testid={`camera-${d.deviceId}`}>
                {d.label || d.deviceId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {streamAudioVisible && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{m.settings_voice_stream_audio()}</span>
          <Select
            value={deviceSettings.streamAudio ?? SYSTEM_AUDIO_AUTO}
            items={streamAudioItems}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              applyStreamAudio(value);
            }}
          >
            <SelectTrigger data-testid="settings-voice-stream-audio" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(streamAudioItems).map(([value, label]) => (
                <SelectItem key={value} value={value} data-testid={`stream-audio-${value}`}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {m.settings_voice_stream_audio_hint()}
          </span>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{m.settings_voice_noise()}</span>
        <RadioGroup
          value={deviceSettings.noiseSuppression}
          data-testid="settings-voice-noise"
          onValueChange={(value) => {
            if (!isNoiseSuppressionMode(value)) return;
            apply({ ...deviceSettings, noiseSuppression: value }, false);
          }}
        >
          {NOISE_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-3 text-sm">
              <RadioGroupItem
                value={option.value}
                className="mt-0.5"
                data-testid={`noise-option-${option.value}`}
              />
              <span className="flex flex-col gap-0.5">
                <span>{option.label()}</span>
                <span className="text-xs text-muted-foreground">{option.hint()}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        {deviceSettings.noiseSuppression === "deepfilter" && (
          <div
            data-testid="settings-voice-deepfilter"
            className="mt-1 flex flex-col gap-4 rounded-md border border-border/50 bg-muted/30 p-3"
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{m.settings_voice_noise_strength()}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{atten}</span>
              </div>
              <Slider
                data-testid="settings-voice-strength"
                min={DEEPFILTER_ATTEN_MIN}
                max={DEEPFILTER_ATTEN_MAX}
                value={[atten]}
                onValueChange={(v) => {
                  const next = oneValue(v);
                  setAtten(next);
                  setDeepfilterAtten(next); // gapless: retune the running worklet live
                }}
                onValueCommitted={(v) => {
                  persistDeviceSettingsOnly({ ...deviceSettings, deepfilterAtten: oneValue(v) });
                }}
              />
              <span className="text-xs text-muted-foreground">
                {m.settings_voice_noise_strength_hint()}
              </span>
            </div>
            <label className="flex items-start justify-between gap-3 text-sm">
              <span className="flex flex-col gap-0.5">
                <span>{m.settings_voice_noise_agc()}</span>
                <span className="text-xs text-muted-foreground">
                  {m.settings_voice_noise_agc_hint()}
                </span>
              </span>
              <Switch
                data-testid="settings-voice-agc"
                checked={deviceSettings.autoGainControl ?? false}
                onCheckedChange={(checked) => {
                  apply({ ...deviceSettings, autoGainControl: checked }, false);
                }}
              />
            </label>
            <span className="text-xs text-muted-foreground">
              {m.settings_voice_noise_echo_locked()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
