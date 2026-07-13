import type { VoiceMember } from "@tavern/shared";
import { EyeIcon, HeadphoneOffIcon, MicOffIcon, MonitorUpIcon, VideoIcon } from "lucide-react";
import { useState } from "react";
import { useStore } from "zustand";
import { useVolumeScroll } from "@/features/volume/useVolumeScroll";
import { UserProfileName } from "@/features/users/UserProfileName";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { useMediaStore } from "@/stores/media";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { getVoiceController } from "./voiceController";

// FR-18/23/26 live voice member chip: avatar + nickname color + green speaking ring + activity
// badges (streaming screen / camera on / watching a stream) + self mute/deafen badges. The profile
// (name/color/avatar) is resolved from the room member list; the speaking ring is driven by the
// local/remote analysers via stores/media.ts; the activity badges by the room's streams + watching
// state (stream.added/removed + watch.state broadcasts).
export function VoiceMemberChip({ serverId, member }: { serverId: string; member: VoiceMember }) {
  const profile = useStore(roomStore(serverId), (s) =>
    s.members.find((mem) => mem.userId === member.userId),
  );
  const speaking = useMediaStore((s) => s.speakingUserIds.has(member.userId));
  // Boolean selectors (not filtered arrays) so an unrelated store change doesn't re-render the chip.
  const sharingScreen = useStore(roomStore(serverId), (s) =>
    s.streams.some((st) => st.userId === member.userId && st.kind === "screen"),
  );
  const sharingCam = useStore(roomStore(serverId), (s) =>
    s.streams.some((st) => st.userId === member.userId && st.kind === "webcam"),
  );
  const watching = useStore(roomStore(serverId), (s) =>
    s.watching.some((w) => w.userId === member.userId),
  );
  const [avatarFailed, setAvatarFailed] = useState(false);
  const displayName = profile?.displayName ?? "";
  const color = profile?.color ?? "#71717a";
  // FR-20: scroll on this member's line to boost/cut THEIR voice locally (0–200%), middle-click to
  // silence. Never on your own chip — you don't hear yourself. The gain lives in settings.volumes.users
  // (read fresh in the handler); the inline percent is a transient echo of the last scroll notch.
  const selfId = useSessionStore((s) => s.profile?.userId ?? null);
  const isSelf = member.userId === selfId;
  const { ref, percent } = useVolumeScroll<HTMLSpanElement>({
    enabled: !isSelf,
    read: () => useSettingsStore.getState().volumes.users[member.userId] ?? 1,
    write: (gain) => getVoiceController().setUserVolume(member.userId, gain),
    meta: () => ({ key: member.userId, label: displayName, color }),
  });
  return (
    <span
      ref={ref}
      data-testid={`voice-chip-${member.userId}`}
      data-speaking={speaking ? "true" : "false"}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-sm",
        !isSelf && "cursor-ns-resize",
      )}
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
      {/* Name + its transient volume echo share the flexible column so the name still truncates and
          the percent sits immediately to its right (shown only just after a scroll notch, then fades). */}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {profile ? <UserProfileName serverId={serverId} member={profile} /> : null}
        {percent !== null && (
          <span
            data-testid={`voice-volume-pct-${member.userId}`}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {percent}%
          </span>
        )}
      </span>

      {/* Right-edge badge cluster. Activity first (streaming screen / camera / watching), then
          mute/deafen. Deafened implies muted: show BOTH "can't talk" (mic) + "can't hear"
          (headphones); muted alone shows just the mic. */}
      {(sharingScreen || sharingCam || watching || member.muted || member.deafened) && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
          {sharingScreen && (
            <MonitorUpIcon
              data-testid={`voice-streaming-screen-${member.userId}`}
              className="size-3.5 text-blue-500 dark:text-blue-400"
            >
              <title>{m.voice_streaming_screen()}</title>
            </MonitorUpIcon>
          )}
          {sharingCam && (
            <VideoIcon
              data-testid={`voice-streaming-cam-${member.userId}`}
              className="size-3.5 text-blue-500 dark:text-blue-400"
            >
              <title>{m.voice_streaming_cam()}</title>
            </VideoIcon>
          )}
          {watching && (
            <EyeIcon data-testid={`voice-watching-${member.userId}`} className="size-3.5">
              <title>{m.voice_watching()}</title>
            </EyeIcon>
          )}
          {member.muted || member.deafened ? (
            <MicOffIcon data-testid={`voice-muted-${member.userId}`} className="size-3.5" />
          ) : null}
          {member.deafened && (
            <HeadphoneOffIcon
              data-testid={`voice-deafened-${member.userId}`}
              className="size-3.5"
            />
          )}
        </span>
      )}
    </span>
  );
}
