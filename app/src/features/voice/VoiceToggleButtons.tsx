import { HeadphoneOffIcon, HeadphonesIcon, MicIcon, MicOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";

// Both voice-control surfaces intentionally render through this component so labels, pressed state,
// icons, and destructive active treatment cannot drift apart.
export function VoiceToggleButtons({
  muted,
  onMutedChange,
  deafened,
  onDeafenedChange,
  disabled = false,
  testIdPrefix,
  buttonClassName,
  activeClassName,
}: {
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  deafened: boolean;
  onDeafenedChange: (deafened: boolean) => void;
  disabled?: boolean;
  testIdPrefix: string;
  buttonClassName: string;
  activeClassName: string;
}) {
  return (
    <>
      <Button
        variant="secondary"
        data-testid={`${testIdPrefix}-mute`}
        aria-label={muted ? m.voice_unmute() : m.voice_mute()}
        aria-pressed={muted}
        disabled={disabled}
        className={cn(buttonClassName, muted && activeClassName)}
        onClick={() => onMutedChange(!muted)}
      >
        {muted ? <MicOffIcon /> : <MicIcon />}
      </Button>
      <Button
        variant="secondary"
        data-testid={`${testIdPrefix}-deafen`}
        aria-label={deafened ? m.voice_undeafen() : m.voice_deafen()}
        aria-pressed={deafened}
        disabled={disabled}
        className={cn(buttonClassName, deafened && activeClassName)}
        onClick={() => onDeafenedChange(!deafened)}
      >
        {deafened ? <HeadphoneOffIcon /> : <HeadphonesIcon />}
      </Button>
    </>
  );
}
