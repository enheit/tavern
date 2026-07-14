import { useRef, useState } from "react";
import { MoreVertical, Pencil, Square, Trash2, Upload, Volume2, VolumeX } from "lucide-react";
import type { Sound } from "@tavern/shared";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { getVoiceController } from "@/features/voice/voiceController";
import { ApiError } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { useInfiniteScroll } from "@/lib/useInfiniteScroll";
import { m } from "@/paraglide/messages.js";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { SoundEditorDialog } from "./SoundEditorDialog";
import { useSounds } from "./useSounds";

type EditorState = "create" | Sound | null;

function reportSoundboardError(error: unknown): void {
  toast.error(error instanceof ApiError ? errorMessage(error.code) : m.soundboard_editor_failed());
}

export function SoundboardPanel({ serverId }: { serverId: string }) {
  const {
    sounds,
    uploadSound,
    replaceSound,
    patchSound,
    deleteSound,
    activateSound,
    stopSound,
    activePlays,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useSounds(serverId);
  const currentUserId = useSessionStore((state) => state.profile?.userId ?? null);
  const adminUserId = useServersStore(
    (state) => state.servers.find((server) => server.id === serverId)?.adminUserId ?? null,
  );
  const soundboardVolume = useSettingsStore((state) => state.volumes.soundboard);
  const soundboardMuted = useSettingsStore((state) => state.volumes.soundboardMuted ?? false);
  const setVolumes = useSettingsStore((state) => state.setVolumes);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleting, setDeleting] = useState<Sound | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useInfiniteScroll({
    scrollRef,
    sentinelRef,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  });

  const canManage = (sound: Sound): boolean =>
    currentUserId !== null && (sound.uploaderId === currentUserId || currentUserId === adminUserId);

  const onVolume = (percent: number): void => {
    const gain = percent / 100;
    setVolumes({ ...useSettingsStore.getState().volumes, soundboard: gain });
    getVoiceController().setSoundboardGain(gain);
  };

  const toggleMute = (): void => {
    const volumes = useSettingsStore.getState().volumes;
    const muted = !(volumes.soundboardMuted ?? false);
    setVolumes({ ...volumes, soundboardMuted: muted });
    getVoiceController().setSoundboardGain(volumes.soundboard);
  };

  return (
    <div data-testid="soundboard-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">{m.soundboard_title()}</span>
        <div className="flex items-center gap-2">
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="soundboard-mute"
            aria-label={soundboardMuted ? m.soundboard_unmute() : m.soundboard_mute()}
            aria-pressed={soundboardMuted}
            onClick={toggleMute}
          >
            {soundboardMuted ? <VolumeX /> : <Volume2 />}
          </Button>
          <div data-testid="soundboard-volume-slot" className="w-24">
            <Slider
              value={[Math.round(soundboardVolume * 100)]}
              min={0}
              max={200}
              step={5}
              aria-label={m.soundboard_volume()}
              data-testid="soundboard-volume"
              onValueChange={(value) => onVolume(Array.isArray(value) ? (value[0] ?? 0) : value)}
            />
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="soundboard-upload-open"
            aria-label={m.soundboard_upload_title()}
            onClick={() => setEditor("create")}
          >
            <Upload />
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-2 gap-2 p-3">
          {sounds.map((sound) => {
            const activePlay = activePlays[sound.id];
            return (
              <div
                key={sound.id}
                data-playing={activePlay !== undefined}
                className="group/sound relative flex min-w-0 items-stretch overflow-hidden rounded-lg border bg-card transition-colors hover:bg-accent"
              >
                {activePlay !== undefined && (
                  <svg
                    key={activePlay.token}
                    aria-hidden={true}
                    className="pointer-events-none absolute inset-0 z-10 size-full overflow-visible"
                  >
                    <rect
                      x="1"
                      y="1"
                      width="calc(100% - 2px)"
                      height="calc(100% - 2px)"
                      rx="7"
                      pathLength="100"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="text-primary"
                      style={{
                        strokeDasharray: 100,
                        strokeDashoffset: 100,
                        animation: `soundboard-border-progress ${activePlay.durationMs}ms linear forwards`,
                      }}
                    />
                  </svg>
                )}
                <button
                  type="button"
                  data-testid={`sound-${sound.id}`}
                  disabled={activePlay !== undefined}
                  onClick={() => void activateSound(sound).catch(reportSoundboardError)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                >
                  <span aria-hidden={true} className="text-xl leading-none">
                    {sound.emoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{sound.name}</span>
                    <span
                      data-testid={`sound-plays-${sound.id}`}
                      className="block text-[11px] text-muted-foreground"
                    >
                      {sound.playCount}
                    </span>
                  </span>
                </button>

                {activePlay !== undefined && (
                  <button
                    type="button"
                    data-testid={`sound-stop-${sound.id}`}
                    aria-label={m.soundboard_stop({ name: sound.name })}
                    className="z-20 self-center rounded-md p-1 text-primary hover:bg-primary/10"
                    onClick={() => {
                      try {
                        stopSound(sound.id);
                      } catch (error: unknown) {
                        reportSoundboardError(error);
                      }
                    }}
                  >
                    <Square className="size-3.5 fill-current" />
                  </button>
                )}

                {canManage(sound) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      data-testid={`sound-menu-${sound.id}`}
                      aria-label={m.soundboard_more_actions({ name: sound.name })}
                      className="mr-1 self-center rounded-md p-1 text-muted-foreground opacity-70 group-hover/sound:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
                    >
                      <MoreVertical className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                      <DropdownMenuItem
                        data-testid={`sound-edit-${sound.id}`}
                        onClick={() => setEditor(sound)}
                      >
                        <Pencil />
                        {m.soundboard_edit()}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        data-testid={`sound-delete-${sound.id}`}
                        onClick={() => setDeleting(sound)}
                      >
                        <Trash2 />
                        {m.soundboard_delete()}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })}
        </div>
        <div ref={sentinelRef} data-testid="sounds-sentinel" className="h-px" />
      </div>

      {editor !== null && (
        <SoundEditorDialog
          key={editor === "create" ? "create" : editor.id}
          open
          serverId={serverId}
          sound={editor === "create" ? null : editor}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setEditor(null);
          }}
          onCreate={uploadSound}
          onPatch={patchSound}
          onReplace={replaceSound}
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.soundboard_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting === null ? "" : m.soundboard_delete_description({ name: deleting.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="sound-delete-confirm"
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleting === null) return;
                void deleteSound(deleting.id).catch(reportSoundboardError);
              }}
            >
              {m.soundboard_delete_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
