import type { Member } from "@tavern/shared";
import { StatsResponse } from "@tavern/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiClient } from "@/lib/apiClient";
import { formatHoursMinutes } from "@/lib/time";
import { m } from "@/paraglide/messages.js";
import { useSessionStore } from "@/stores/session";

function ProfileAvatar({ member }: { member: Member }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        data-testid={`profile-avatar-fallback-${member.userId}`}
        className="flex size-20 items-center justify-center rounded-full text-2xl font-semibold text-white"
        style={{ backgroundColor: member.color }}
      >
        {member.displayName.charAt(0)}
      </span>
    );
  }
  return (
    <img
      src={`/api/media/avatars/${member.userId}.webp`}
      alt={member.displayName}
      data-testid={`profile-avatar-${member.userId}`}
      onError={() => setFailed(true)}
      className="size-20 rounded-full bg-muted object-cover"
    />
  );
}

export function UserProfileDialog({
  serverId,
  member,
  onOpenChange,
}: {
  serverId: string;
  member: Member;
  onOpenChange: (open: boolean) => void;
}) {
  const selfUserId = useSessionStore((state) => state.profile?.userId);
  const query = useQuery({
    queryKey: ["stats", serverId],
    queryFn: () => apiClient.get(`/api/servers/${serverId}/stats`, StatsResponse),
    staleTime: 10_000,
  });
  const stats = query.data?.perUser.find((entry) => entry.userId === member.userId);
  const watchedSeconds =
    query.data?.watchPairs
      .filter((pair) => pair.viewerId === selfUserId && pair.streamerId === member.userId)
      .reduce((total, pair) => total + pair.seconds, 0) ?? 0;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="user-profile-dialog" className="sm:max-w-xs">
        <DialogHeader className="items-center text-center">
          <ProfileAvatar member={member} />
          <DialogTitle
            data-testid="user-profile-name"
            className="pt-1 text-sm"
            style={{ color: member.color }}
          >
            {member.displayName}
          </DialogTitle>
          <p data-testid="user-profile-username" className="text-xs text-muted-foreground">
            @{member.username}
          </p>
        </DialogHeader>
        <section aria-label={m.user_profile_stats()} className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-muted/60 p-2 text-center">
            <div data-testid="user-profile-messages" className="font-semibold tabular-nums">
              {stats?.messages ?? 0}
            </div>
            <div className="pt-0.5 text-[11px] leading-tight text-muted-foreground">
              {m.stats_messages()}
            </div>
          </div>
          <div className="rounded-lg bg-muted/60 p-2 text-center">
            <div data-testid="user-profile-streamed" className="font-semibold tabular-nums">
              {formatHoursMinutes(stats?.streamSeconds ?? 0)}
            </div>
            <div className="pt-0.5 text-[11px] leading-tight text-muted-foreground">
              {m.stats_hours_streamed()}
            </div>
          </div>
          <div className="rounded-lg bg-muted/60 p-2 text-center">
            <div data-testid="user-profile-watched" className="font-semibold tabular-nums">
              {formatHoursMinutes(watchedSeconds)}
            </div>
            <div className="pt-0.5 text-[11px] leading-tight text-muted-foreground">
              {m.user_profile_watched_by_you()}
            </div>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
