import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import type { Sound } from "@tavern/shared";
import { LIMITS } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { authTransport } from "@/lib/authTransport";
import { m } from "@/paraglide/messages.js";

// Region fill is a plugin option, not CSS — wavesurfer regions live in a Shadow DOM (pinned).
const REGION_COLOR = "rgba(99, 102, 241, 0.25)";
const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

// The waveform seam the dialog drives. The default binds real wavesurfer; tests inject a mock so the
// save-mapping / disable logic is exercised without a real audio pipeline.
export interface WaveSurferControl {
  play(startSec: number, endSec: number): void;
  destroy(): void;
}
export interface WaveSurferInit {
  container: HTMLElement;
  mediaUrl: string;
  region: { startSec: number; endSec: number };
  onRegionChange(region: { startSec: number; endSec: number }): void;
}
export type WaveSurferFactory = (init: WaveSurferInit) => WaveSurferControl;

// Default factory: real wavesurfer + ONE bounded region (drag + resize). The mp3 is fetched with auth
// (R2 reads are member-gated) → object URL → wavesurfer.load. Preview plays the [start,end] slice.
const defaultFactory: WaveSurferFactory = ({ container, mediaUrl, region, onRegionChange }) => {
  const ws = WaveSurfer.create({ container });
  const regions = ws.registerPlugin(RegionsPlugin.create());
  let objectUrl: string | null = null;

  void (async () => {
    const headers = await authTransport.getAuthHeaders();
    const res = await fetch(mediaUrl, { headers, credentials: "include" });
    objectUrl = URL.createObjectURL(await res.blob());
    await ws.load(objectUrl);
  })();

  ws.on("decode", () => {
    regions.addRegion({
      start: region.startSec,
      end: region.endSec,
      drag: true,
      resize: true,
      color: REGION_COLOR,
    });
  });
  regions.on("region-updated", (updated) => {
    onRegionChange({ startSec: updated.start, endSec: updated.end ?? updated.start });
  });

  return {
    play: (startSec, endSec) => {
      void ws.play(startSec, endSec);
    },
    destroy: () => {
      ws.destroy();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    },
  };
};

interface TrimDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  serverId: string;
  sound: Sound;
  onSave(soundId: string, patch: { trimStartMs: number; trimEndMs: number }): Promise<unknown>;
  createWaveSurfer?: WaveSurferFactory;
}

// FR-35 trim dialog: waveform + one region → non-destructive trimStart/End (metadata only). Save maps
// the region's seconds to whole ms (Math.round) and PATCHes; save is disabled while the window is
// under soundMinTrimMs.
export function TrimDialog({
  open,
  onOpenChange,
  serverId,
  sound,
  onSave,
  createWaveSurfer = defaultFactory,
}: TrimDialogProps) {
  // Callback-ref state (not useRef): the dialog popup mounts on a second render, so the effect must
  // re-run once the waveform container element attaches.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const controlRef = useRef<WaveSurferControl | null>(null);
  const [region, setRegion] = useState({
    startSec: sound.trimStartMs / 1000,
    endSec: sound.trimEndMs / 1000,
  });
  const [saving, setSaving] = useState(false);

  const mediaUrl = useMemo(
    () => `${API_BASE}/api/media/sounds/${serverId}/${sound.id}.mp3`,
    [serverId, sound.id],
  );

  useEffect(() => {
    if (!open || container === null) return undefined;
    const control = createWaveSurfer({
      container,
      mediaUrl,
      region: { startSec: sound.trimStartMs / 1000, endSec: sound.trimEndMs / 1000 },
      onRegionChange: setRegion,
    });
    controlRef.current = control;
    return () => {
      control.destroy();
      controlRef.current = null;
    };
  }, [open, container, mediaUrl, sound.trimStartMs, sound.trimEndMs, createWaveSurfer]);

  const trimStartMs = Math.round(region.startSec * 1000);
  const trimEndMs = Math.round(region.endSec * 1000);
  const saveDisabled = saving || trimEndMs - trimStartMs < LIMITS.soundMinTrimMs;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onSave(sound.id, { trimStartMs, trimEndMs });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.soundboard_trim_title()}</DialogTitle>
        </DialogHeader>
        <div ref={setContainer} data-testid="trim-waveform" className="min-h-24 w-full" />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="trim-preview"
            onClick={() => controlRef.current?.play(region.startSec, region.endSec)}
          >
            {m.soundboard_trim_preview()}
          </Button>
          <Button
            type="button"
            data-testid="trim-save"
            disabled={saveDisabled}
            onClick={() => {
              void save();
            }}
          >
            {m.soundboard_trim_save()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
