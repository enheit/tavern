import { useEffect, useState } from "react";
import type { BasePresetId, PresetId, ScreenAccessStatus, ScreenSource } from "@tavern/shared";
import { BASE_PRESET_IDS, DEFAULT_SCREEN_PRESET, PRESET_IDS } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { platform } from "@/platform/types";
import type { ShareSelection } from "./types";

// Preset option labels (technical resolution×fps identifiers, kept as data — like the AppSection
// language endonyms — so they stay out of the i18n catalog; rendered via {expression}, never JSX text).
// Keyed by the 12 BASE ids only — the picker never offers data tiers; those are tuned live in the
// ControlsBar after the share is up.
export const PRESET_ITEMS: Record<BasePresetId, string> = {
  "480p15": "480p · 15fps",
  "480p30": "480p · 30fps",
  "480p60": "480p · 60fps",
  "720p15": "720p · 15fps",
  "720p30": "720p · 30fps",
  "720p60": "720p · 60fps",
  "1080p15": "1080p · 15fps",
  "1080p30": "1080p · 30fps",
  "1080p60": "1080p · 60fps",
  "1440p15": "1440p · 15fps",
  "1440p30": "1440p · 30fps",
  "1440p60": "1440p · 60fps",
};

export function isPreset(value: unknown): value is PresetId {
  return typeof value === "string" && PRESET_IDS.some((id) => id === value);
}

interface SharePickerDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onStart(sel: ShareSelection): void;
}

// FR-28 source/quality/audio picker. Desktop: Screens/Windows tabs of enumerated sources + preset +
// a Share-audio switch — enabled where the OS loopback device exists (win/mac) AND on Linux, where
// audio rides the pactl remap-source + AEC fallback instead (media/capture.ts) — the S8.1
// "hidden on Linux" pin is revised by that fallback. Web: preset + an audio hint only — the
// browser's native picker chooses the source and audio.
export function SharePickerDialog({ open, onOpenChange, onStart }: SharePickerDialogProps) {
  const isDesktop = platform.kind === "desktop";
  const audioSwitchVisible = isDesktop;
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [preset, setPreset] = useState<PresetId>(DEFAULT_SCREEN_PRESET);
  const [loopbackSupported, setLoopbackSupported] = useState(false);
  const [withAudio, setWithAudio] = useState(false);
  // Defaults to "granted" so the permission hint never flashes while the real status loads.
  const [accessStatus, setAccessStatus] = useState<ScreenAccessStatus>("granted");

  useEffect(() => {
    if (!open || !isDesktop) return;
    let cancelled = false;
    // On macOS the getSources call below is also what registers Tavern in the Screen Recording
    // privacy list (and triggers the one-time system prompt on 15+) — keep it before the status
    // read so a fresh install lands in System Settings with the row already present.
    void platform.capture.getScreenSources().then((list) => {
      if (!cancelled) setSources(list);
    });
    void platform.capture.screenAccessStatus().then((status) => {
      if (!cancelled) setAccessStatus(status);
    });
    void platform.capture.loopbackAudioSupported().then((ok) => {
      if (!cancelled) setLoopbackSupported(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [open, isDesktop]);

  const pickSource = (id: string): void => {
    setSourceId(id);
    // Arm the main-process display-media handler now (§6.3); captureScreen re-arms at capture time.
    void platform.capture.selectSource(id);
  };

  const start = (): void => {
    if (isDesktop && sourceId === null) return;
    onStart({ sourceId, preset, withAudio: isDesktop ? audioSwitchVisible && withAudio : true });
  };

  const screens = sources.filter((s) => s.id.startsWith("screen:"));
  const windows = sources.filter((s) => !s.id.startsWith("screen:"));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.streams_share_title()}</DialogTitle>
          {!isDesktop && <DialogDescription>{m.streams_share_web_hint()}</DialogDescription>}
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {isDesktop &&
            accessStatus !== "granted" && (
              // macOS denies the whole source list without the Screen Recording permission — the
              // tabs would both be empty grids, so route to System Settings instead.
              <div
                data-testid="share-permission-hint"
                className="flex flex-col gap-3 rounded-lg border border-border bg-muted/50 p-4"
              >
                <p className="text-sm text-muted-foreground">{m.streams_share_permission_hint()}</p>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="share-open-settings"
                  onClick={() => platform.capture.openScreenRecordingSettings()}
                >
                  {m.streams_share_open_settings()}
                </Button>
              </div>
            )}
          {isDesktop && accessStatus === "granted" && (
            <Tabs defaultValue="screens">
              <TabsList>
                <TabsTrigger value="screens" data-testid="share-tab-screens">
                  {m.streams_share_tab_screens()}
                </TabsTrigger>
                <TabsTrigger value="windows" data-testid="share-tab-windows">
                  {m.streams_share_tab_windows()}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="screens">
                <SourceGrid sources={screens} selectedId={sourceId} onPick={pickSource} />
              </TabsContent>
              <TabsContent value="windows">
                <SourceGrid sources={windows} selectedId={sourceId} onPick={pickSource} />
              </TabsContent>
            </Tabs>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{m.streams_share_quality()}</span>
            <Select
              value={preset}
              items={PRESET_ITEMS}
              onValueChange={(value) => {
                if (isPreset(value)) setPreset(value);
              }}
            >
              <SelectTrigger data-testid="share-preset" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASE_PRESET_IDS.map((id) => (
                  <SelectItem key={id} value={id} data-testid={`preset-option-${id}`}>
                    {PRESET_ITEMS[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {audioSwitchVisible && (
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>{m.streams_share_audio()}</span>
              <Switch
                checked={withAudio}
                disabled={!loopbackSupported && platform.os !== "linux"}
                data-testid="share-audio"
                onCheckedChange={setWithAudio}
              />
            </label>
          )}
          <Button
            data-testid="share-start"
            disabled={isDesktop && sourceId === null}
            onClick={start}
          >
            {m.streams_share_start()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourceGrid({
  sources,
  selectedId,
  onPick,
}: {
  sources: ScreenSource[];
  selectedId: string | null;
  onPick(id: string): void;
}) {
  if (sources.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        {m.streams_share_no_sources()}
      </p>
    );
  }
  return (
    <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto py-1">
      {sources.map((source) => (
        <button
          key={source.id}
          type="button"
          data-testid={`share-source-${source.id}`}
          onClick={() => onPick(source.id)}
          className={cn(
            "flex flex-col gap-1 rounded-lg border border-border p-1.5 text-left text-xs hover:bg-accent",
            selectedId === source.id && "ring-2 ring-primary",
          )}
        >
          <img
            src={source.thumbnailDataUrl}
            alt={source.name}
            className="aspect-video w-full rounded object-cover"
          />
          <span className="truncate">{source.name}</span>
        </button>
      ))}
    </div>
  );
}
