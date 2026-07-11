import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { getWebcamController } from "@/features/streams/useWebcam";
import { m } from "@/paraglide/messages.js";
import { useMediaStore } from "@/stores/media";
import {
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
// "rnnoise"/"deepfilter" = WASM AudioWorklet models (see media/noiseWorklet.ts); "off" = AEC only.
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
    value: "rnnoise",
    label: m.settings_voice_noise_rnnoise,
    hint: m.settings_voice_noise_rnnoise_hint,
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

export function VoiceSettingsSection() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const deviceSettings = useSettingsStore((s) => s.deviceSettings);
  const inVoice = useMediaStore((s) => s.inVoiceServerId !== null);

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

  // FR-29 camera switch: persist the selection, then — if the webcam is publishing — swap the camera
  // mid-publish (stop → getCam → replaceTrack, no renegotiation). Idle → the next start uses the new id.
  const applyCamera = (cameraDeviceId: string): void => {
    const next = { ...deviceSettings, cameraDeviceId };
    useSettingsStore.getState().setDeviceSettings(next);
    useMediaStore.getState().setDeviceSelection(next);
    void getWebcamController().switchDevice(cameraDeviceId);
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
      </div>
    </div>
  );
}
