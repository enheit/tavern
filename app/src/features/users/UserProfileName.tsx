import type { Member } from "@tavern/shared";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { MarketIcon } from "@/features/market/MarketIcon";
import { UserProfileDialog } from "./UserProfileDialog";

export function UserProfileName({
  serverId,
  member,
  className,
  testId,
}: {
  serverId: string;
  member: Member;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testId ?? `user-profile-trigger-${member.userId}`}
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 text-left underline-offset-2 hover:underline focus-visible:underline",
          className,
        )}
        style={{ color: member.color }}
      >
        <span className="truncate hover:underline focus-visible:underline">
          {member.displayName}
        </span>
        {member.marketIcon === undefined ? null : (
          <MarketIcon
            serverId={serverId}
            itemId={member.marketIcon.itemId}
            name={member.marketIcon.name}
          />
        )}
      </button>
      {open ? (
        <UserProfileDialog serverId={serverId} member={member} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}
