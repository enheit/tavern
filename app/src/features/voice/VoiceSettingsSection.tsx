import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages.js";
import { useMediaStore } from "@/stores/media";
import { type DeviceSettingsV1, useSettingsStore } from "@/stores/settings";
import { getVoiceController } from "./voiceController";

// FR-21/22 Voice settings tab: input/output device pickers + noise-suppression toggle. Device labels
// require mic permission (enumerateDevices returns blank labels otherwise, MDN). Changing input or
// noise mid-call retoggles the mic (stop→reacquire→replaceTrack); changing output calls graph.setSink.
function toItems(devices: MediaDeviceInfo[]): Record<string, string> {
  const items: Record<string, string> = {};
  for (const d of devices) items[d.deviceId] = d.label || d.deviceId;
  return items;
}

export function VoiceSettingsSection() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
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
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>{m.settings_voice_noise()}</span>
        <Switch
          checked={deviceSettings.noiseSuppression}
          data-testid="settings-voice-noise"
          onCheckedChange={(next) => apply({ ...deviceSettings, noiseSuppression: next }, false)}
        />
      </label>
    </div>
  );
}
