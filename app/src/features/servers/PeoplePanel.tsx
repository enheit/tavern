import type { Member, Presence } from "@tavern/shared";
import { useState } from "react";
import { useStore } from "zustand";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";

// FR-45 People panel with live presence. Sort comparator is pinned: admins first, then presence rank
// (in-voice → online → offline), then displayName. Presence dot + name color are the pinned styles.
const PRESENCE_RANK: Record<Presence, number> = { "in-voice": 0, online: 1, offline: 2 };
const PRESENCE_DOT: Record<Presence, string> = {
  offline: "bg-gray-400",
  online: "bg-green-500",
  "in-voice": "bg-violet-500",
};

export function sortMembers(members: Member[]): Member[] {
  return members.toSorted((a, b) => {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    const rank = PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence];
    if (rank !== 0) return rank;
    return a.displayName.localeCompare(b.displayName);
  });
}

export function PeoplePanel({ serverId }: { serverId: string }) {
  const members = useStore(roomStore(serverId), (s) => s.members);
  return (
    <section data-testid="people-panel" className="flex min-h-0 flex-1 flex-col">
      <h2 className="px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {m.people_title()}
      </h2>
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {sortMembers(members).map((member) => (
          <MemberRow key={member.userId} member={member} />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({ member }: { member: Member }) {
  // The avatar is optimistically an <img>; a 404 (no avatar uploaded yet) falls back to a colored
  // block with the first character of the displayName.
  const [avatarFailed, setAvatarFailed] = useState(false);
  return (
    <li
      data-testid={`member-${member.userId}`}
      className="flex items-center gap-2 rounded-md px-2 py-1"
    >
      <span className="relative shrink-0">
        {avatarFailed ? (
          <span
            data-testid={`avatar-fallback-${member.userId}`}
            className="flex size-7 items-center justify-center rounded-full text-xs font-medium text-white"
            style={{ backgroundColor: member.color }}
          >
            {member.displayName.charAt(0)}
          </span>
        ) : (
          <img
            src={`/api/media/avatars/${member.userId}.webp`}
            alt={member.displayName}
            data-testid={`avatar-img-${member.userId}`}
            onError={() => setAvatarFailed(true)}
            className="size-7 rounded-full bg-muted object-cover"
          />
        )}
        <span
          data-testid={`presence-${member.userId}`}
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
            PRESENCE_DOT[member.presence],
          )}
        />
      </span>
      <span
        data-testid={`member-name-${member.userId}`}
        className="truncate text-sm"
        style={{ color: member.color }}
      >
        {member.displayName}
      </span>
    </li>
  );
}
