import type { ReactNode } from "react";
import { useStore } from "zustand";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Slider } from "@/components/ui/slider";
import { useKickMember } from "@/features/admin/useKickMember";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { getVoiceController } from "./voiceController";

// FR-20 per-user local volume + mute. Right-clicking a People-panel row opens this menu. The slider
// DISPLAYS 0–200% (default 100%, step 5%); the stored value is always the gain float 0..2. "Mute
// <name>" is set membership in VolumesV1.mutedUsers (NOT a gain of 0), so the slider position
// survives a mute/unmute. FR-11: when self is the server admin and the target is someone else, the
// menu also offers Kick (same confirm flow as the admin dialog, via useKickMember).
export function VolumeMenu({
  userId,
  name,
  children,
}: {
  userId: string;
  name: string;
  children: ReactNode;
}) {
  const activeServerId = useServersStore((s) => s.activeServerId);
  const serverId = activeServerId ?? "";
  const selfId = useSessionStore((s) => s.profile?.userId ?? null);
  const adminUserId = useStore(roomStore(serverId), (s) => s.serverMeta?.adminUserId ?? null);
  const gain = useSettingsStore((s) => s.volumes.users[userId] ?? 1);
  const muted = useSettingsStore((s) => s.volumes.mutedUsers.includes(userId));
  const controller = getVoiceController();
  const kick = useKickMember(serverId);
  const percent = Math.round(gain * 100);
  const showKick =
    activeServerId !== null && selfId !== null && adminUserId === selfId && userId !== selfId;
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1">
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56" data-testid={`volume-menu-${userId}`}>
          <div className="px-2 py-1.5">
            <div className="flex items-center justify-between text-xs">
              <span>{m.voice_volume()}</span>
              <span className="text-muted-foreground tabular-nums">{percent}%</span>
            </div>
            <Slider
              value={[percent]}
              min={0}
              max={200}
              step={5}
              data-testid={`volume-slider-${userId}`}
              className="mt-2"
              onValueChange={(value) => {
                const next = Array.isArray(value) ? (value[0] ?? 0) : value;
                controller.setUserVolume(userId, next / 100);
              }}
            />
          </div>
          <ContextMenuSeparator />
          <ContextMenuItem
            data-testid={`volume-reset-${userId}`}
            onClick={() => controller.setUserVolume(userId, 1)}
          >
            {m.voice_reset()}
          </ContextMenuItem>
          <ContextMenuCheckboxItem
            checked={muted}
            data-testid={`volume-mute-${userId}`}
            onCheckedChange={(checked) => controller.setUserMuted(userId, checked)}
          >
            {m.voice_mute_user({ name })}
          </ContextMenuCheckboxItem>
          {showKick && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                data-testid={`kick-menu-item-${userId}`}
                onClick={() => kick.confirmAndKick(userId)}
              >
                {m.admin_kick()}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {showKick && kick.dialog}
    </>
  );
}
