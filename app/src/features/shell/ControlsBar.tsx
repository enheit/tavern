import {
  HeadphoneOffIcon,
  HeadphonesIcon,
  MicIcon,
  MicOffIcon,
  MonitorUpIcon,
  VideoIcon,
} from "lucide-react";
import { useState } from "react";
import type { DataTier, PresetId } from "@tavern/shared";
import {
  DATA_TIERS,
  DEFAULT_SCREEN_PRESET,
  SCREEN_PRESETS,
  isBasePresetId,
  withTier,
} from "@tavern/shared";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { cn } from "@/lib/utils";
import { RecordButton } from "@/features/recordings/RecordButton";
import { SharePickerDialog } from "@/features/streams/SharePickerDialog";
import { useScreenShare } from "@/features/streams/useScreenShare";
import { useWebcam } from "@/features/streams/useWebcam";
import { useVoice } from "@/features/voice/useVoice";
import { m } from "@/paraglide/messages.js";
import { platform } from "@/platform/types";

// FR-27/28/29 controls bar under the canvas (§7.6). Screen-share, webcam and record — large buttons,
// shown ONLY while in voice on this server. Share defaults to 1080p60; two segmented button-groups pick
// resolution + fps independently (combined into a PresetId) and show the active choice. Changing a group
// while sharing re-applies live (setPreset — fps ceiling + encoder downscale, no renegotiation).

// Resolution options → capture height + short label ("480"/"720"/"HD"/"2K"). Data, not i18n (rendered
// via {expression} like PRESET_ITEMS, so it stays out of the catalog / check-literals gate).
const RES_OPTIONS: ReadonlyArray<{ height: number; label: string }> = [
  { height: 480, label: "480" },
  { height: 720, label: "720" },
  { height: 1080, label: "HD" },
  { height: 1440, label: "2K" },
];
const FPS_OPTIONS: readonly number[] = [15, 30, 60];

// Combine the three segmented selections into a PresetId (all 4×3 base combos × 4 data tiers exist).
// isBasePresetId narrows without an assertion; the default is a safety fallback only (every real
// combo is valid). The tier scales ONLY the encoder's bitrate cap — labels promise data, not quality.
function toPreset(height: number, fps: number, tier: DataTier): PresetId {
  const id = `${height}p${fps}`;
  return isBasePresetId(id) ? withTier(id, tier) : DEFAULT_SCREEN_PRESET;
}

export function ControlsBar({ serverId }: { serverId: string }) {
  const { status, inVoiceServerId, muted, setMuted, deafened, setDeafened } = useVoice(serverId);
  const active = inVoiceServerId === serverId && (status === "joined" || status === "joining");
  const { sharing, start: startShare, stop: stopShare, setPreset } = useScreenShare();
  const { active: camming, start: startCam, stop: stopCam } = useWebcam();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [tier, setTier] = useState<DataTier>(100);

  // Main share button: stop while sharing; else start now (web) or open the source dialog (desktop).
  // A share ALWAYS starts at 1080p30 (DEFAULT_SCREEN_PRESET); res/fps are tuned live afterwards, so the
  // segmented groups are reset to the default here and only shown once the share is up.
  const onShareClick = (): void => {
    if (sharing) {
      void stopShare();
      return;
    }
    if (platform.kind === "desktop") {
      setPickerOpen(true);
      return;
    }
    setHeight(1080);
    setFps(30);
    setTier(100);
    void startShare({ sourceId: null, preset: DEFAULT_SCREEN_PRESET, withAudio: true });
  };

  // Segmented picks: update state, and if a share is live re-apply the new preset on the fly.
  const applyHeight = (next: number): void => {
    setHeight(next);
    if (sharing) void setPreset(toPreset(next, fps, tier));
  };
  const applyFps = (next: number): void => {
    setFps(next);
    if (sharing) void setPreset(toPreset(height, next, tier));
  };
  const applyTier = (next: DataTier): void => {
    setTier(next);
    if (sharing) void setPreset(toPreset(height, fps, next));
  };

  // Icon-only action buttons (square) + the segmented res/fps value buttons. The selected segment gets
  // a soft blue tint (same soft-fill language as the VoicePanel mute/deafen active state).
  const icon = "size-12 rounded-xl [&_svg]:size-5";
  const seg = "h-12 rounded-xl px-3.5";
  const segActive = "bg-blue-500/15 text-blue-600 hover:bg-blue-500/25 dark:text-blue-400";
  // Active share/webcam = "click to stop" → soft red fill (no ring).
  const stopActive = "bg-destructive/15 text-destructive hover:bg-destructive/25";

  return (
    <div data-testid="controls-bar" className="flex h-full items-center justify-center gap-2 p-2">
      {active && (
        <>
          {/* FR-27 screen share: main = start@selection / stop. */}
          <Button
            variant="secondary"
            data-testid="controls-screen"
            aria-pressed={sharing}
            aria-label={sharing ? m.streams_share_stop() : m.streams_share_open()}
            className={cn(icon, sharing && stopActive)}
            onClick={onShareClick}
          >
            <MonitorUpIcon />
          </Button>
          {/* FR-28 res/fps segmented groups — shown ONLY while sharing (live tuning; you can't pick
              quality before starting). Active segment = current selection. */}
          {sharing && (
            <>
              <ButtonGroup>
                {RES_OPTIONS.map((opt) => (
                  <Button
                    key={opt.height}
                    variant="secondary"
                    aria-pressed={height === opt.height}
                    data-testid={`share-res-${opt.height}`}
                    className={cn(seg, height === opt.height && segActive)}
                    onClick={() => applyHeight(opt.height)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </ButtonGroup>
              <ButtonGroup>
                {FPS_OPTIONS.map((value) => (
                  <Button
                    key={value}
                    variant="secondary"
                    aria-pressed={fps === value}
                    data-testid={`share-fps-${value}`}
                    className={cn(seg, "tabular-nums", fps === value && segActive)}
                    onClick={() => applyFps(value)}
                  >
                    {value}
                  </Button>
                ))}
              </ButtonGroup>
              {/* Data-budget tier (percent of the preset's bitrate cap). Deliberately labeled as data,
                  never "quality" — the visible effect depends on content (text: none; motion: choppier),
                  so quality percentages would be a promise we can't keep. 100% is the default. */}
              <ButtonGroup>
                {DATA_TIERS.map((value) => (
                  <Button
                    key={value}
                    variant="secondary"
                    aria-pressed={tier === value}
                    data-testid={`share-data-${value}`}
                    className={cn(seg, "tabular-nums", tier === value && segActive)}
                    onClick={() => applyTier(value)}
                  >
                    {value}%
                  </Button>
                ))}
              </ButtonGroup>
            </>
          )}
          {/* While live, push webcam/record to the right so the screen controls sit on the left. */}
          {sharing && <div className="flex-1" />}
          {/* FR-29 webcam: idle↔active; click while active = stop. */}
          <Button
            variant="secondary"
            data-testid="controls-cam"
            aria-pressed={camming}
            aria-label={camming ? m.streams_cam_stop() : m.streams_cam_start()}
            className={cn(icon, camming && stopActive)}
            onClick={() => (camming ? void stopCam() : void startCam())}
          >
            <VideoIcon />
          </Button>
          {/* FR-25 record toggle (the red REC dot sits next to the session timer in the channel row). */}
          <RecordButton serverId={serverId} inVoice={active} className={icon} />
          {/* FR-26 self mute + deafen (moved here from the VoicePanel) — red soft fill while engaged. */}
          <Button
            variant="secondary"
            data-testid="controls-mute"
            aria-label={muted ? m.voice_unmute() : m.voice_mute()}
            aria-pressed={muted}
            className={cn(icon, muted && stopActive)}
            onClick={() => setMuted(!muted)}
          >
            {muted ? <MicOffIcon /> : <MicIcon />}
          </Button>
          <Button
            variant="secondary"
            data-testid="controls-deafen"
            aria-label={deafened ? m.voice_undeafen() : m.voice_deafen()}
            aria-pressed={deafened}
            className={cn(icon, deafened && stopActive)}
            onClick={() => setDeafened(!deafened)}
          >
            {deafened ? <HeadphoneOffIcon /> : <HeadphonesIcon />}
          </Button>
        </>
      )}
      {/* Desktop still needs source selection — the main button opens this dialog there. */}
      <SharePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onStart={(sel) => {
          setPickerOpen(false);
          // Sync the segmented groups to the picked preset (the picker offers base presets only, so
          // the data tier always restarts at 100%) — the live-tuning controls must not lie on open.
          const spec = SCREEN_PRESETS[sel.preset];
          setHeight(spec.height);
          setFps(spec.fps);
          setTier(100);
          void startShare(sel);
        }}
      />
    </div>
  );
}
