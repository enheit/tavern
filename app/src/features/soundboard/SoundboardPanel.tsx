import { useState } from "react";
import { Upload } from "lucide-react";
import type { Sound } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { getVoiceController } from "@/features/voice/voiceController";
import { useSessionStore } from "@/stores/session";
import { useServersStore } from "@/stores/servers";
import { useSettingsStore } from "@/stores/settings";
import { m } from "@/paraglide/messages.js";
import { useSounds } from "./useSounds";
import { UploadDialog } from "./UploadDialog";
import { TrimDialog } from "./TrimDialog";

// FR-34/35/37 soundboard panel (§7.6 bottom-right region): a scrollable grid of sound buttons (name +
// play-count badge), an upload button + a volume-slider slot (S9.2 fills it), and a per-sound context
// menu with Edit/Delete shown only to the uploader or the server admin. Playback is S9.2.
export function SoundboardPanel({ serverId }: { serverId: string }) {
  const { sounds, uploadSound, patchSound, deleteSound, sendPlay } = useSounds(serverId);
  const currentUserId = useSessionStore((state) => state.profile?.userId ?? null);
  const adminUserId = useServersStore(
    (state) => state.servers.find((s) => s.id === serverId)?.adminUserId ?? null,
  );
  const soundboardVolume = useSettingsStore((state) => state.volumes.soundboard);
  const setVolumes = useSettingsStore((state) => state.setVolumes);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState<Sound | null>(null);

  const canManage = (sound: Sound): boolean =>
    currentUserId !== null && (sound.uploaderId === currentUserId || currentUserId === adminUserId);

  // FR-38: the slider DISPLAYS 0–200%; the stored value is the gain float 0..2 in settings.volumes.v1.
  // Persist it AND apply to the live audio graph (only soundboard output — independent of user/stream
  // gains). §7.3: setSoundboardGain routes to the app graph's sbGain node.
  const onVolume = (percent: number): void => {
    const gain = percent / 100;
    setVolumes({ ...useSettingsStore.getState().volumes, soundboard: gain });
    getVoiceController().setSoundboardGain(gain);
  };
  const volumePercent = Math.round(soundboardVolume * 100);

  return (
    <div data-testid="soundboard-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">{m.soundboard_title()}</span>
        <div className="flex items-center gap-2">
          {/* FR-38 soundboard volume slot (0–200%). */}
          <div data-testid="soundboard-volume-slot" className="w-24">
            <Slider
              value={[volumePercent]}
              min={0}
              max={200}
              step={5}
              aria-label={m.soundboard_volume()}
              data-testid="soundboard-volume"
              onValueChange={(value) => {
                onVolume(Array.isArray(value) ? (value[0] ?? 0) : value);
              }}
            />
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="soundboard-upload-open"
            aria-label={m.soundboard_upload_title()}
            onClick={() => setUploadOpen(true)}
          >
            <Upload />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-2 gap-2 p-3">
          {sounds.map((sound) => (
            <ContextMenu key={sound.id}>
              <ContextMenuTrigger
                render={
                  <button
                    type="button"
                    data-testid={`sound-${sound.id}`}
                    onClick={() => sendPlay(sound.id)}
                    className="flex items-center justify-between gap-2 rounded-md border bg-card px-2 py-1.5 text-left text-sm hover:bg-accent"
                  />
                }
              >
                <span className="truncate">{sound.name}</span>
                <span
                  data-testid={`sound-plays-${sound.id}`}
                  className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground"
                >
                  {sound.playCount}
                </span>
              </ContextMenuTrigger>
              {canManage(sound) && (
                <ContextMenuContent>
                  <ContextMenuItem
                    data-testid={`sound-edit-${sound.id}`}
                    onClick={() => setEditing(sound)}
                  >
                    {m.soundboard_edit()}
                  </ContextMenuItem>
                  <ContextMenuItem
                    variant="destructive"
                    data-testid={`sound-delete-${sound.id}`}
                    onClick={() => {
                      void deleteSound(sound.id);
                    }}
                  >
                    {m.soundboard_delete()}
                  </ContextMenuItem>
                </ContextMenuContent>
              )}
            </ContextMenu>
          ))}
        </div>
      </ScrollArea>

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} onUpload={uploadSound} />
      {editing !== null && (
        <TrimDialog
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          serverId={serverId}
          sound={editing}
          onSave={patchSound}
        />
      )}
    </div>
  );
}
