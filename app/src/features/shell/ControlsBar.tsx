import {
  CircleIcon,
  HeadphoneOffIcon,
  HeadphonesIcon,
  LogInIcon,
  MicIcon,
  MicOffIcon,
  MonitorUpIcon,
  PhoneOffIcon,
  VideoIcon,
} from "lucide-react";
import { useState } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SharePickerDialog } from "@/features/streams/SharePickerDialog";
import { useScreenShare } from "@/features/streams/useScreenShare";
import { TimerChip } from "@/features/voice/TimerChip";
import { useVoice } from "@/features/voice/useVoice";
import { VoiceElsewhereError } from "@/features/voice/voiceController";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";

// FR-18/24/26 controls bar (§7.6). Join/Leave state button, self-mute, deafen, session timer chip;
// screen-share/cam/record stay disabled placeholders (S8.1/S8.3/S9.3). The timer is visible to ALL
// members while a session is active — driven by the active server's voice.state.sessionStartedAt.
export function ControlsBar({ serverId }: { serverId: string }) {
  const sessionStartedAt = useStore(roomStore(serverId), (s) => s.voice.sessionStartedAt);
  const { status, inVoiceServerId, join, leave, muted, setMuted, deafened, setDeafened } =
    useVoice(serverId);
  const active = inVoiceServerId === serverId && (status === "joined" || status === "joining");
  const { sharing, start: startShare, stop: stopShare } = useScreenShare();
  const [pickerOpen, setPickerOpen] = useState(false);

  const onJoin = (): void => {
    void join().catch((err) => {
      // The single-voice confirm lives on the channel row; here we only guard against the throw.
      if (!(err instanceof VoiceElsewhereError)) throw err;
    });
  };

  return (
    <div data-testid="controls-bar" className="flex h-full items-center gap-1.5 px-3">
      {active ? (
        <Button
          variant="destructive"
          size="sm"
          data-testid="controls-leave"
          onClick={() => void leave()}
        >
          <PhoneOffIcon />
          {m.voice_leave()}
        </Button>
      ) : (
        <Button variant="secondary" size="sm" data-testid="controls-join" onClick={onJoin}>
          <LogInIcon />
          {m.voice_join()}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="controls-mute"
        aria-label={muted ? m.voice_unmute() : m.voice_mute()}
        aria-pressed={muted}
        disabled={!active}
        className={cn(muted && "text-destructive")}
        onClick={() => setMuted(!muted)}
      >
        {muted ? <MicOffIcon /> : <MicIcon />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="controls-deafen"
        aria-label={deafened ? m.voice_undeafen() : m.voice_deafen()}
        aria-pressed={deafened}
        disabled={!active}
        className={cn(deafened && "text-destructive")}
        onClick={() => setDeafened(!deafened)}
      >
        {deafened ? <HeadphoneOffIcon /> : <HeadphonesIcon />}
      </Button>
      <span className="mx-1 h-5 w-px bg-border" />
      {/* FR-27 screen share: idle↔sharing (pulsing accent ring); click while sharing = stop. */}
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="controls-screen"
        aria-label={sharing ? m.streams_share_stop() : m.streams_share_open()}
        aria-pressed={sharing}
        disabled={!active}
        className={cn(sharing && "animate-pulse text-primary ring-2 ring-primary/60")}
        onClick={() => (sharing ? void stopShare() : setPickerOpen(true))}
      >
        <MonitorUpIcon />
      </Button>
      {/* Disabled placeholders — webcam (S8.3), record (S9.3). */}
      <Button variant="ghost" size="icon-sm" data-testid="controls-cam" disabled>
        <VideoIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" data-testid="controls-record" disabled>
        <CircleIcon />
      </Button>
      <div className="flex-1" />
      <TimerChip sessionStartedAt={sessionStartedAt} />
      <SharePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onStart={(sel) => {
          setPickerOpen(false);
          void startShare(sel);
        }}
      />
    </div>
  );
}
