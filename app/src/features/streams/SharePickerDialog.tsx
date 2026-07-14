import { useEffect, useState } from "react";
import type {
  BasePresetId,
  DataTier,
  PresetId,
  ScreenAccessStatus,
  ScreenSource,
} from "@tavern/shared";
import {
  BASE_PRESET_IDS,
  DATA_TIERS,
  DEFAULT_SCREEN_PRESET,
  PORTAL_SOURCE_ID,
  PRESET_IDS,
  basePresetOf,
  isBasePresetId,
  tierOf,
  withTier,
} from "@tavern/shared";
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

function isDataTier(value: number): value is DataTier {
  return DATA_TIERS.some((candidate) => candidate === value);
}

interface SharePickerDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onStart(sel: ShareSelection): void;
  initialPreset?: PresetId;
}

// FR-28 source/quality picker. Every share requests audio: desktop uses OS loopback or the Linux
// venmic / pactl fallback (media/capture.ts), while web capture delegates the actual audio grant to
// the browser's native picker. Desktop Wayland ("portal" sourceMode) has no grid because enumerated
// ids die with each portal session; its OS ScreenCast dialog chooses the source at capture time.
export function SharePickerDialog({
  open,
  onOpenChange,
  onStart,
  initialPreset = DEFAULT_SCREEN_PRESET,
}: SharePickerDialogProps) {
  const isDesktop = platform.kind === "desktop";
  const portalPicker = isDesktop && platform.capture.sourceMode === "portal";
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [preset, setPreset] = useState<PresetId>(DEFAULT_SCREEN_PRESET);
  // Defaults to "granted" so the permission hint never flashes while the real status loads.
  const [accessStatus, setAccessStatus] = useState<ScreenAccessStatus>("granted");

  useEffect(() => {
    if (open) setPreset(initialPreset);
  }, [initialPreset, open]);

  useEffect(() => {
    if (!open || !isDesktop) return;
    let cancelled = false;
    if (!portalPicker) {
      // On macOS the getSources call below is also what registers Tavern in the Screen Recording
      // privacy list (and triggers the one-time system prompt on 15+) — keep it before the status
      // read so a fresh install lands in System Settings with the row already present.
      // Portal mode NEVER enumerates here: on Wayland every getSources opens an OS portal dialog,
      // and its session (with the ids) would be dead by capture time anyway.
      void platform.capture.getScreenSources().then((list) => {
        if (!cancelled) setSources(list);
      });
      void platform.capture.screenAccessStatus().then((status) => {
        if (!cancelled) setAccessStatus(status);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [open, isDesktop, portalPicker]);

  useEffect(() => {
    // Portal mode has no grid pick — arm the handler with the sentinel so Start is enabled and the
    // main process accepts the display-media request when it arrives.
    if (!open || !portalPicker) return;
    setSourceId(PORTAL_SOURCE_ID);
    void platform.capture.selectSource(PORTAL_SOURCE_ID);
  }, [open, portalPicker]);

  const pickSource = (id: string): void => {
    setSourceId(id);
    // Arm the main-process display-media handler now (§6.3); captureScreen re-arms at capture time.
    void platform.capture.selectSource(id);
  };

  const start = (): void => {
    if (isDesktop && sourceId === null) return;
    onStart({ sourceId, preset, withAudio: true });
  };

  const screens = sources.filter((s) => s.id.startsWith("screen:"));
  const windows = sources.filter((s) => !s.id.startsWith("screen:"));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.streams_share_title()}</DialogTitle>
          {!isDesktop && <DialogDescription>{m.streams_share_web_hint()}</DialogDescription>}
          {portalPicker && <DialogDescription>{m.streams_share_portal_hint()}</DialogDescription>}
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {isDesktop &&
            !portalPicker &&
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
          {isDesktop && !portalPicker && accessStatus === "granted" && (
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
              value={basePresetOf(preset)}
              items={PRESET_ITEMS}
              onValueChange={(value) => {
                if (typeof value === "string" && isBasePresetId(value)) {
                  setPreset(withTier(value, tierOf(preset)));
                }
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
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{m.streams_share_data_budget()}</span>
            <Select
              value={String(tierOf(preset))}
              items={{ "100": "100%", "75": "75%", "50": "50%", "35": "35%" }}
              onValueChange={(value) => {
                const parsed = Number(value);
                if (isDataTier(parsed)) {
                  setPreset(withTier(basePresetOf(preset), parsed));
                }
              }}
            >
              <SelectTrigger data-testid="share-data-tier" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATA_TIERS.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
