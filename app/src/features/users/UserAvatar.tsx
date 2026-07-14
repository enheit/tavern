import type { UserProfile } from "@tavern/shared";
import { useState } from "react";
import { cn } from "@/lib/utils";

// Self-profile avatar presentation is shared by the sidebar and account editor. `revision` changes
// after an upload because avatar objects intentionally keep a stable storage key; it forces the
// browser to request the newly written bytes instead of retaining a stale cached image.
export function UserAvatar({
  profile,
  revision,
  className,
  testId,
}: {
  profile: UserProfile;
  revision: number;
  className?: string;
  testId?: string;
}) {
  const [failedRevision, setFailedRevision] = useState<number | null>(null);
  const hasAvatar = profile.avatarKey !== undefined && failedRevision !== revision;

  if (!hasAvatar) {
    return (
      <span
        data-testid={testId}
        className={cn(
          "flex items-center justify-center rounded-full text-sm font-semibold text-white",
          className,
        )}
        style={{ backgroundColor: profile.color }}
      >
        {profile.displayName.charAt(0)}
      </span>
    );
  }

  return (
    <img
      src={`/api/media/avatars/${profile.userId}.webp?v=${revision}`}
      alt={profile.displayName}
      data-testid={testId}
      onError={() => setFailedRevision(revision)}
      className={cn("rounded-full bg-muted object-cover", className)}
    />
  );
}
