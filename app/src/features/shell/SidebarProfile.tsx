import type { Presence } from "@tavern/shared";
import { SettingsIcon, Volume2Icon } from "lucide-react";
import { useState } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { AccountSettingsDialog } from "@/features/settings/AccountSettingsDialog";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { UserAvatar } from "@/features/users/UserAvatar";
import { MarketIcon } from "@/features/market/MarketIcon";
import { useVoice } from "@/features/voice/useVoice";
import { VoiceToggleButtons } from "@/features/voice/VoiceToggleButtons";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

function presenceLabel(presence: Presence): string {
  if (presence === "in-voice") return m.sidebar_presence_in_voice();
  if (presence === "online") return m.sidebar_presence_online();
  return m.sidebar_presence_offline();
}

// The single self-profile entry point in the app shell. The identity block opens account editing,
// while the adjacent gear opens application settings; the controls never compete in a menu.
export function SidebarProfile({ serverId }: { serverId: string }) {
  const profile = useSessionStore((state) => state.profile);
  const avatarRevision = useSessionStore((state) => state.avatarRevision);
  const selfMember = useStore(roomStore(serverId), (state) =>
    profile === null ? undefined : state.members.find((member) => member.userId === profile.userId),
  );
  const presence: Presence = selfMember?.presence ?? "offline";
  const { status, muted, setMuted, deafened, setDeafened } = useVoice(serverId);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (profile === null) return null;

  return (
    <>
      <div data-testid="sidebar-profile" className="flex items-center gap-2 border-t bg-card p-2">
        <button
          type="button"
          data-testid="sidebar-profile-avatar-button"
          aria-label={m.settings_tabs_account()}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => setAccountOpen(true)}
        >
          <span className="relative shrink-0">
            <UserAvatar
              profile={profile}
              revision={avatarRevision}
              testId="sidebar-profile-avatar"
              className="size-9"
            />
            <span
              data-testid="sidebar-profile-presence"
              data-presence={presence}
              className={cn(
                "absolute right-0 bottom-0 size-3 rounded-full border-2 border-card",
                presence === "offline" ? "bg-gray-400" : "bg-green-500",
              )}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span
              data-testid="sidebar-profile-name"
              className="block truncate text-sm font-medium"
              style={{ color: profile.color }}
            >
              <span className="inline-flex max-w-full items-center gap-1">
                <span className="truncate">{profile.displayName}</span>
                {selfMember?.marketIcon === undefined ? null : (
                  <MarketIcon
                    serverId={serverId}
                    itemId={selfMember.marketIcon.itemId}
                    name={selfMember.marketIcon.name}
                  />
                )}
              </span>
            </span>
            <span
              data-testid="sidebar-profile-status"
              data-presence={presence}
              className="flex items-center gap-1 truncate text-xs text-muted-foreground"
            >
              {presence === "in-voice" ? <Volume2Icon className="size-3 text-green-600" /> : null}
              {presenceLabel(presence)}
            </span>
          </span>
        </button>
        <VoiceToggleButtons
          muted={muted}
          onMutedChange={setMuted}
          deafened={deafened}
          onDeafenedChange={setDeafened}
          disabled={status === "joining" || status === "leaving"}
          testIdPrefix="sidebar"
          buttonClassName="size-7 rounded-md"
          activeClassName="bg-destructive/15 text-destructive hover:bg-destructive/25"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="sidebar-settings-button"
          aria-label={m.settings_title()}
          title={m.settings_title()}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon />
        </Button>
      </div>
      {accountOpen ? (
        <AccountSettingsDialog
          serverId={serverId}
          open={accountOpen}
          onOpenChange={setAccountOpen}
        />
      ) : null}
      <SettingsDialog serverId={serverId} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
