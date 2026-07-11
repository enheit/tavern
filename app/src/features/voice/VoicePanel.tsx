import { PhoneOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stopRecording } from "@/features/recordings/RecordButton";
import { m } from "@/paraglide/messages.js";
import { useVoice } from "./useVoice";

// FR-18/26 voice panel pinned to the very bottom of the left column. Rendered ONLY while connected to
// voice on this server: a single full-width, red "Good bye" button that closes the call. Mute/deafen
// moved to the ControlsBar right group. Leave stops any self-owned recording first (FR-25 graceful
// path); a bare leave would dirty-end (discard) the recording server-side.
export function VoicePanel({ serverId }: { serverId: string }) {
  const { status, inVoiceServerId, leave } = useVoice(serverId);
  const active = inVoiceServerId === serverId && (status === "joined" || status === "joining");
  if (!active) return null;

  const onLeave = async (): Promise<void> => {
    await stopRecording(serverId);
    await leave();
  };

  return (
    <div data-testid="voice-panel" className="p-2">
      <Button
        variant="secondary"
        data-testid="controls-leave"
        aria-label={m.voice_leave()}
        className="h-12 w-full rounded-xl bg-destructive/15 text-destructive hover:bg-destructive/25 [&_svg]:size-5"
        onClick={() => void onLeave()}
      >
        <PhoneOffIcon />
        {m.voice_goodbye()}
      </Button>
    </div>
  );
}
