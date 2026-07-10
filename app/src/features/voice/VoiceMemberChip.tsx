import type { VoiceMember } from "@tavern/shared";
import { HeadphoneOffIcon, MicOffIcon } from "lucide-react";
import { useState } from "react";
import { useStore } from "zustand";
import { cn } from "@/lib/utils";
import { useMediaStore } from "@/stores/media";
import { roomStore } from "@/stores/room";

// FR-18/23/26 live voice member chip: avatar + nickname color + green speaking ring + self
// mute/deafen badges. The profile (name/color/avatar) is resolved from the room member list; the
// speaking ring is driven by the local/remote analysers via stores/media.ts.
export function VoiceMemberChip({ serverId, member }: { serverId: string; member: VoiceMember }) {
  const profile = useStore(roomStore(serverId), (s) =>
    s.members.find((m) => m.userId === member.userId),
  );
  const speaking = useMediaStore((s) => s.speakingUserIds.has(member.userId));
  const [avatarFailed, setAvatarFailed] = useState(false);
  const displayName = profile?.displayName ?? "";
  const color = profile?.color ?? "#71717a";
  return (
    <span
      data-testid={`voice-chip-${member.userId}`}
      data-speaking={speaking ? "true" : "false"}
      className="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-sm"
    >
      <span className="relative shrink-0">
        {avatarFailed ? (
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full text-[10px] font-medium text-white ring-2",
              speaking ? "ring-green-500" : "ring-transparent",
            )}
            style={{ backgroundColor: color }}
          >
            {displayName.charAt(0)}
          </span>
        ) : (
          <img
            src={`/api/media/avatars/${member.userId}.webp`}
            alt={displayName}
            onError={() => setAvatarFailed(true)}
            className={cn(
              "size-5 rounded-full bg-muted object-cover ring-2",
              speaking ? "ring-green-500" : "ring-transparent",
            )}
          />
        )}
      </span>
      <span className="truncate" style={{ color }}>
        {displayName}
      </span>
      {member.deafened ? (
        <HeadphoneOffIcon data-testid={`voice-deafened-${member.userId}`} className="size-3.5" />
      ) : member.muted ? (
        <MicOffIcon data-testid={`voice-muted-${member.userId}`} className="size-3.5" />
      ) : null}
    </span>
  );
}
