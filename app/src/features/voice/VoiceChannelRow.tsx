import { Volume2Icon } from "lucide-react";
import { useState } from "react";
import { useStore } from "zustand";
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
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { TimerChip } from "./TimerChip";
import { useVoice } from "./useVoice";
import { VoiceMemberChip } from "./VoiceMemberChip";
import { VoiceElsewhereError } from "./voiceController";

// FR-18 voice channel row (Channels panel). Click joins; live member chips show who is in voice.
// Joining while in voice on another server prompts the single-voice confirm (leave there, join here).
// FR-24 the session timer sits on the right of this row (visible to ALL members while a session runs).
export function VoiceChannelRow({ serverId }: { serverId: string }) {
  const voiceMembers = useStore(roomStore(serverId), (s) => s.voice.members);
  const sessionStartedAt = useStore(roomStore(serverId), (s) => s.voice.sessionStartedAt);
  const recordingActive = useStore(roomStore(serverId), (s) => s.recording.active);
  const { join, leave, status, inVoiceServerId } = useVoice(serverId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const joinedHere = inVoiceServerId === serverId && status === "joined";

  const onClick = (): void => {
    void join().catch((err) => {
      if (err instanceof VoiceElsewhereError) setConfirmOpen(true);
    });
  };
  const onConfirm = (): void => {
    setConfirmOpen(false);
    void (async () => {
      await leave();
      await join();
    })();
  };

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        data-testid="channel-voice"
        onClick={onClick}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          joinedHere && "bg-accent text-accent-foreground",
        )}
      >
        <Volume2Icon className="size-4 shrink-0" />
        <span className="truncate">{m.channels_voice()}</span>
        <span className="ml-auto flex items-center gap-1.5 pl-1">
          {/* FR-25 REC dot: the channel is being recorded (visible to ALL members, like the timer). */}
          {recordingActive && (
            <span
              data-testid="rec-indicator"
              title={m.recording_indicator()}
              className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
            />
          )}
          <TimerChip sessionStartedAt={sessionStartedAt} />
        </span>
      </button>
      {voiceMembers.length > 0 && (
        <ul data-testid="voice-members" className="flex flex-col gap-0.5 pl-4">
          {voiceMembers.map((member) => (
            <li key={member.userId}>
              <VoiceMemberChip serverId={serverId} member={member} />
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="voice-elsewhere-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.voice_elsewhere_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.voice_elsewhere_body()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="voice-elsewhere-cancel">
              {m.voice_elsewhere_cancel()}
            </AlertDialogCancel>
            <AlertDialogAction data-testid="voice-elsewhere-confirm" onClick={onConfirm}>
              {m.voice_elsewhere_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
