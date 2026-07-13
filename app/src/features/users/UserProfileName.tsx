import type { Member } from "@tavern/shared";
import { useState } from "react";
import { cn } from "@/lib/utils";
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
          "min-w-0 truncate text-left underline-offset-2 hover:underline focus-visible:underline",
          className,
        )}
        style={{ color: member.color }}
      >
        {member.displayName}
      </button>
      {open ? (
        <UserProfileDialog serverId={serverId} member={member} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}
