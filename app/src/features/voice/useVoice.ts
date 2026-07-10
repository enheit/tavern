import type { VoiceStatus } from "@/stores/media";
import { useMediaStore } from "@/stores/media";
import { getVoiceController } from "./voiceController";

// The ONLY seam components use to drive voice. Selectors come from stores/media.ts (the controller
// is the sole writer); the actions delegate to the app-wide controller. `join` rejects with
// VoiceElsewhereError when already in voice on another server (the confirm flow).
export function useVoice(serverId: string): {
  status: VoiceStatus;
  inVoiceServerId: string | null;
  join: () => Promise<void>;
  leave: () => Promise<void>;
  muted: boolean;
  setMuted: (m: boolean) => void;
  deafened: boolean;
  setDeafened: (d: boolean) => void;
} {
  const status = useMediaStore((s) => s.voiceStatus);
  const inVoiceServerId = useMediaStore((s) => s.inVoiceServerId);
  const muted = useMediaStore((s) => s.muted);
  const deafened = useMediaStore((s) => s.deafened);
  const controller = getVoiceController();
  return {
    status,
    inVoiceServerId,
    join: () => controller.join(serverId),
    leave: () => controller.leave(),
    muted,
    setMuted: (m) => controller.setMuted(m),
    deafened,
    setDeafened: (d) => controller.setDeafened(d),
  };
}
