import { useEffect, useRef, useState } from "react";
import { FileAudio, Minus, Play, Plus, Square, UploadCloud } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import type { PatchSoundRequest, Sound } from "@tavern/shared";
import { LIMITS, ReactionEmoji } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EmojiPicker,
  EmojiPickerContent,
  EmojiPickerFooter,
  EmojiPickerSearch,
} from "@/components/ui/emoji-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { getVoiceController } from "@/features/voice/voiceController";
import { authTransport } from "@/lib/authTransport";
import { cn } from "@/lib/utils";
import { decodeDurationMs } from "@/media/decodeDuration";
import { m } from "@/paraglide/messages.js";
import type { SoundUploadInput } from "./useSounds";

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";
const REGION_COLOR = "rgba(99, 102, 241, 0.28)";
const WAVE_COLOR = "#a1a1aa";
const PREVIEW_CURSOR_COLOR = "#ef4444";
const ZOOM_LEVELS = [1, 2, 4, 8] as const;

export interface SoundWaveformControl {
  setPlayhead(timeSec: number | null): void;
  setZoom(factor: number): void;
  destroy(): void;
}

export interface SoundWaveformInit {
  container: HTMLElement;
  file: File;
  region: { startSec: number; endSec: number };
  onRegionChange(region: { startSec: number; endSec: number }): void;
  onError(error: unknown): void;
}

export type SoundWaveformFactory = (init: SoundWaveformInit) => SoundWaveformControl;

export const createSoundWaveform: SoundWaveformFactory = ({
  container,
  file,
  region,
  onRegionChange,
  onError,
}) => {
  const objectUrl = URL.createObjectURL(file);
  let decodedDuration = 0;
  let zoomFactor = 1;
  let playheadVisible = false;
  const wavesurfer = WaveSurfer.create({
    container,
    height: 72,
    waveColor: WAVE_COLOR,
    progressColor: WAVE_COLOR,
    cursorColor: "transparent",
    cursorWidth: 2,
    autoCenter: false,
    autoScroll: false,
    normalize: true,
  });
  const regions = wavesurfer.registerPlugin(RegionsPlugin.create());
  const applyZoom = (): void => {
    if (decodedDuration <= 0) return;
    const fitPxPerSec = container.clientWidth / decodedDuration;
    wavesurfer.zoom(zoomFactor === 1 ? 0 : fitPxPerSec * zoomFactor);
  };
  wavesurfer.on("decode", (duration) => {
    decodedDuration = duration;
    regions.addRegion({
      start: region.startSec,
      end: region.endSec,
      drag: true,
      resize: true,
      color: REGION_COLOR,
    });
    applyZoom();
  });
  regions.on("region-updated", (updated) => {
    onRegionChange({ startSec: updated.start, endSec: updated.end ?? updated.start });
  });
  void wavesurfer.load(objectUrl).catch(onError);
  return {
    setPlayhead: (timeSec) => {
      if (timeSec === null) {
        if (playheadVisible) wavesurfer.setOptions({ cursorColor: "transparent" });
        playheadVisible = false;
        return;
      }
      if (!playheadVisible) wavesurfer.setOptions({ cursorColor: PREVIEW_CURSOR_COLOR });
      playheadVisible = true;
      const boundedTime = Math.max(0, Math.min(decodedDuration, timeSec));
      wavesurfer.setTime(boundedTime);
      if (zoomFactor > 1 && decodedDuration > 0) {
        const visibleDuration = decodedDuration / zoomFactor;
        wavesurfer.setScrollTime(Math.max(0, boundedTime - visibleDuration / 2));
      }
    },
    setZoom: (factor) => {
      zoomFactor = factor;
      applyZoom();
    },
    destroy: () => {
      wavesurfer.destroy();
      URL.revokeObjectURL(objectUrl);
    },
  };
};

interface SoundEditorDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  serverId: string;
  sound: Sound | null;
  onCreate(input: SoundUploadInput): Promise<unknown>;
  onPatch(soundId: string, patch: PatchSoundRequest): Promise<unknown>;
  onReplace(soundId: string, input: SoundUploadInput): Promise<unknown>;
  measureDurationMs?: (file: File) => Promise<number>;
  createWaveform?: SoundWaveformFactory;
}

function fileNameToSoundName(fileName: string): string {
  return fileName
    .replace(/\.mp3$/i, "")
    .trim()
    .slice(0, LIMITS.soundNameMax);
}

function isMp3(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith(".mp3") &&
    (file.type === "" || file.type === "audio/mpeg" || file.type === "audio/mp3")
  );
}

function editorErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : m.soundboard_editor_failed();
}

export function SoundEditorDialog({
  open,
  onOpenChange,
  serverId,
  sound,
  onCreate,
  onPatch,
  onReplace,
  measureDurationMs = decodeDurationMs,
  createWaveform = createSoundWaveform,
}: SoundEditorDialogProps) {
  const [name, setName] = useState(sound?.name ?? "");
  const [emoji, setEmoji] = useState(sound?.emoji ?? "");
  const [gain, setGain] = useState(sound?.gain ?? 1);
  const [durationMs, setDurationMs] = useState(sound?.durationMs ?? 0);
  const [region, setRegion] = useState({
    startSec: (sound?.trimStartMs ?? 0) / 1000,
    endSec: (sound?.trimEndMs ?? 0) / 1000,
  });
  const initialWaveformRegion = useRef(region);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [replacementSelected, setReplacementSelected] = useState(false);
  const [loadingSource, setLoadingSource] = useState(sound !== null);
  const [dragging, setDragging] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [waveformContainer, setWaveformContainer] = useState<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const waveformControlRef = useRef<SoundWaveformControl | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const previewRunRef = useRef(0);
  const dragDepth = useRef(0);
  const zoomFactor = ZOOM_LEVELS[zoomIndex] ?? 1;
  const zoomFactorRef = useRef<number>(zoomFactor);
  zoomFactorRef.current = zoomFactor;

  useEffect(() => {
    if (sound === null) return undefined;
    const abort = new AbortController();
    void (async () => {
      try {
        const headers = await authTransport.getAuthHeaders();
        const response = await fetch(`${API_BASE}/api/media/sounds/${serverId}/${sound.id}.mp3`, {
          headers,
          credentials: "include",
          signal: abort.signal,
        });
        if (!response.ok) throw new Error(m.soundboard_editor_source_failed());
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        setSourceFile(new File([blob], sound.sourceFileName, { type: "audio/mpeg" }));
        setLoadingSource(false);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(editorErrorMessage(loadError));
        setLoadingSource(false);
      }
    })();
    return () => abort.abort();
  }, [serverId, sound]);

  useEffect(() => {
    if (sourceFile === null || waveformContainer === null) return undefined;
    const control = createWaveform({
      container: waveformContainer,
      file: sourceFile,
      region: initialWaveformRegion.current,
      onRegionChange: setRegion,
      onError: (waveError) => setError(editorErrorMessage(waveError)),
    });
    waveformControlRef.current = control;
    control.setZoom(zoomFactorRef.current);
    return () => {
      if (waveformControlRef.current === control) waveformControlRef.current = null;
      control.destroy();
    };
  }, [sourceFile, waveformContainer, createWaveform]);

  useEffect(() => {
    waveformControlRef.current?.setZoom(zoomFactor);
  }, [zoomFactor]);

  useEffect(
    () => () => {
      previewRunRef.current += 1;
      if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
      waveformControlRef.current?.setPlayhead(null);
      getVoiceController().stopSoundboardPreview();
    },
    [],
  );

  const clearPreviewPlayhead = (): void => {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
    previewFrameRef.current = null;
    waveformControlRef.current?.setPlayhead(null);
  };

  const stopPreview = (): void => {
    previewRunRef.current += 1;
    clearPreviewPlayhead();
    getVoiceController().stopSoundboardPreview();
    setPreviewing(false);
  };

  const selectFile = async (file: File): Promise<void> => {
    setError(null);
    if (!isMp3(file)) {
      setError(m.soundboard_editor_mp3_only());
      return;
    }
    if (file.size > LIMITS.soundMaxBytes) {
      setError(m.soundboard_editor_file_too_large());
      return;
    }
    try {
      const measuredDuration = await measureDurationMs(file);
      if (measuredDuration > LIMITS.soundMaxDurationMs) {
        setError(m.soundboard_upload_too_long());
        return;
      }
      if (measuredDuration < LIMITS.soundMinTrimMs) {
        setError(m.soundboard_editor_too_short());
        return;
      }
      const fullRegion = { startSec: 0, endSec: measuredDuration / 1000 };
      initialWaveformRegion.current = fullRegion;
      setSourceFile(file);
      setDurationMs(measuredDuration);
      setRegion(fullRegion);
      setZoomIndex(0);
      setReplacementSelected(sound !== null);
      if (sound === null && name.trim() === "") setName(fileNameToSoundName(file.name));
    } catch (decodeError) {
      setError(editorErrorMessage(decodeError));
    }
  };

  const trimStartMs = Math.max(0, Math.round(region.startSec * 1000));
  const trimEndMs = Math.min(durationMs, Math.round(region.endSec * 1000));
  const trimValid = trimEndMs - trimStartMs >= LIMITS.soundMinTrimMs;
  const nameValid = name.trim().length >= 1 && name.trim().length <= LIMITS.soundNameMax;
  const emojiValid = ReactionEmoji.safeParse(emoji).success;
  const canSave =
    !saving && sourceFile !== null && !loadingSource && trimValid && nameValid && emojiValid;

  const uploadInput = (): SoundUploadInput => {
    if (sourceFile === null || durationMs <= 0)
      throw new Error(m.soundboard_upload_file_required());
    return {
      file: sourceFile,
      name: name.trim(),
      emoji,
      gain,
      durationMs,
      trimStartRatio: trimStartMs / durationMs,
      trimEndRatio: trimEndMs / durationMs,
    };
  };

  const preview = async (): Promise<void> => {
    if (sourceFile === null || !trimValid) return;
    const runId = previewRunRef.current + 1;
    previewRunRef.current = runId;
    const startPreviewPlayhead = (): void => {
      if (previewRunRef.current !== runId) return;
      if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
      const startedAt = performance.now();
      const startSec = trimStartMs / 1000;
      const endSec = trimEndMs / 1000;
      waveformControlRef.current?.setPlayhead(startSec);
      const update = (now: number): void => {
        if (previewRunRef.current !== runId) return;
        const currentSec = Math.min(endSec, startSec + (now - startedAt) / 1000);
        waveformControlRef.current?.setPlayhead(currentSec);
        if (currentSec < endSec) previewFrameRef.current = requestAnimationFrame(update);
      };
      previewFrameRef.current = requestAnimationFrame(update);
    };
    setPreviewing(true);
    setError(null);
    try {
      const bytes = await sourceFile.arrayBuffer();
      if (previewRunRef.current !== runId) return;
      await getVoiceController().previewSoundFile(
        serverId,
        bytes,
        {
          trimStartMs,
          trimEndMs,
          gain,
        },
        startPreviewPlayhead,
      );
    } catch (previewError) {
      if (previewRunRef.current === runId) setError(editorErrorMessage(previewError));
    } finally {
      if (previewRunRef.current === runId) {
        clearPreviewPlayhead();
        setPreviewing(false);
      }
    }
  };

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (sound === null) {
        await onCreate(uploadInput());
      } else if (replacementSelected) {
        await onReplace(sound.id, uploadInput());
      } else {
        await onPatch(sound.id, {
          name: name.trim(),
          emoji,
          gain,
          trimStartMs,
          trimEndMs,
        });
      }
      onOpenChange(false);
    } catch (saveError) {
      setError(editorErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const close = (nextOpen: boolean): void => {
    if (!nextOpen) stopPreview();
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[min(42rem,calc(100vw-1rem))] max-w-none gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 px-4 pt-4 pr-12 pb-3">
          <DialogTitle>
            {sound === null ? m.soundboard_upload_title() : m.soundboard_editor_edit_title()}
          </DialogTitle>
        </DialogHeader>

        <div
          data-testid="sound-editor-body"
          className="flex min-h-0 flex-col gap-3 overflow-x-hidden overflow-y-auto px-4 pb-3"
        >
          <div className="flex flex-col gap-1.5">
            <Label>{m.soundboard_upload_file()}</Label>
            <div
              data-testid="sound-file-dropzone"
              data-dragging={dragging}
              className={cn(
                "flex min-h-16 min-w-0 items-center gap-2.5 rounded-lg border border-dashed p-2.5 transition-colors",
                dragging && "border-primary bg-primary/5",
              )}
              onDragEnter={(event) => {
                event.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                dragDepth.current -= 1;
                if (dragDepth.current === 0) setDragging(false);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                dragDepth.current = 0;
                setDragging(false);
                const dropped = event.dataTransfer.files[0];
                if (dropped !== undefined) void selectFile(dropped);
              }}
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                {sourceFile === null ? (
                  <UploadCloud className="size-5" />
                ) : (
                  <FileAudio className="size-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {loadingSource
                    ? m.soundboard_editor_loading_source()
                    : (sourceFile?.name ?? m.soundboard_editor_drop_file())}
                </p>
                <p className="text-xs text-muted-foreground">{m.soundboard_editor_file_help()}</p>
              </div>
              <Input
                ref={fileInputRef}
                id="sound-editor-file"
                data-testid="sound-editor-file"
                type="file"
                accept="audio/mpeg,.mp3"
                className="hidden"
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  if (selected !== undefined) void selectFile(selected);
                  event.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingSource}
                onClick={() => fileInputRef.current?.click()}
              >
                {m.soundboard_editor_browse()}
              </Button>
            </div>
            {replacementSelected && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {m.soundboard_editor_replacement_notice()}
              </p>
            )}
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-3 min-[28rem]:grid-cols-[minmax(0,1fr)_9rem]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sound-editor-name">{m.soundboard_upload_name()}</Label>
              <Input
                id="sound-editor-name"
                data-testid="sound-editor-name"
                value={name}
                maxLength={LIMITS.soundNameMax}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{m.soundboard_editor_emoji()}</Label>
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger
                  data-testid="sound-editor-emoji"
                  className="flex h-9 items-center gap-2 rounded-md border bg-muted px-3 text-left"
                >
                  <span className="text-lg">{emoji || "◌"}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {emoji ? m.soundboard_editor_change() : m.soundboard_editor_choose()}
                  </span>
                </PopoverTrigger>
                <PopoverContent align="end" className="h-[352px] w-[320px] p-0">
                  <EmojiPicker
                    emojibaseUrl="/emojibase"
                    onEmojiSelect={(picked) => {
                      setEmoji(picked.emoji);
                      setEmojiOpen(false);
                    }}
                    className="h-full"
                  >
                    <EmojiPickerSearch />
                    <EmojiPickerContent />
                    <EmojiPickerFooter />
                  </EmojiPicker>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div className="min-w-0 overflow-hidden rounded-lg border bg-muted/30 p-2.5">
            <div
              ref={setWaveformContainer}
              data-testid="sound-editor-waveform"
              className="min-h-18 min-w-0"
            />
            <div className="mt-2 flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
              <div className="flex min-w-0 flex-1 items-center justify-between tabular-nums">
                <span>
                  {m.soundboard_editor_seconds_short({
                    seconds: (trimStartMs / 1000).toFixed(2),
                  })}
                </span>
                <span>
                  {m.soundboard_editor_seconds_short({
                    seconds: ((trimEndMs - trimStartMs) / 1000).toFixed(2),
                  })}
                </span>
                <span>
                  {m.soundboard_editor_seconds_short({
                    seconds: (trimEndMs / 1000).toFixed(2),
                  })}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  data-testid="sound-editor-zoom-out"
                  aria-label={m.soundboard_editor_zoom_out()}
                  disabled={zoomIndex === 0}
                  onClick={() => setZoomIndex((current) => Math.max(0, current - 1))}
                >
                  <Minus />
                </Button>
                <span
                  data-testid="sound-editor-zoom-level"
                  className="w-9 text-center tabular-nums"
                >
                  {zoomFactor}×
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  data-testid="sound-editor-zoom-in"
                  aria-label={m.soundboard_editor_zoom_in()}
                  disabled={zoomIndex === ZOOM_LEVELS.length - 1}
                  onClick={() =>
                    setZoomIndex((current) => Math.min(ZOOM_LEVELS.length - 1, current + 1))
                  }
                >
                  <Plus />
                </Button>
              </div>
            </div>
            {!trimValid && sourceFile !== null && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {m.soundboard_editor_trim_too_short()}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>{m.soundboard_editor_volume()}</Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(gain * 100)}%
              </span>
            </div>
            <Slider
              data-testid="sound-editor-volume"
              value={[Math.round(gain * 100)]}
              min={0}
              max={200}
              step={5}
              onValueChange={(value) =>
                setGain((Array.isArray(value) ? (value[0] ?? 100) : value) / 100)
              }
            />
          </div>

          {(!nameValid || !emojiValid) && (
            <p className="text-xs text-muted-foreground">
              {!nameValid
                ? m.soundboard_upload_name_invalid()
                : m.soundboard_editor_emoji_required()}
            </p>
          )}
          {error !== null && (
            <p role="alert" data-testid="sound-editor-error" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none px-4 py-3 min-[28rem]:flex-row min-[28rem]:justify-end">
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {m.common_cancel()}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="sound-editor-preview"
            disabled={!previewing && (sourceFile === null || !trimValid)}
            onClick={() => {
              if (previewing) stopPreview();
              else void preview();
            }}
          >
            {previewing ? <Square className="fill-current" /> : <Play />}
            {previewing ? m.soundboard_editor_stop_preview() : m.soundboard_trim_preview()}
          </Button>
          <Button
            type="button"
            data-testid="sound-editor-save"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {sound === null ? m.soundboard_upload_submit() : m.soundboard_trim_save()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
