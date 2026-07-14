import { AudioLinesIcon, MicOffIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { MarketIcon } from "@/features/market/MarketIcon";
import type { VoiceLoungeMember } from "@/features/home/VoiceLounge";
import { useVoiceAvatarStage } from "@/features/home/useVoiceAvatarStage";
import { cn } from "@/lib/utils";
import { useMediaStore } from "@/stores/media";

export function VoiceAvatarTile({
  active,
  compact = false,
  member: { profile, voice },
  onFocus,
  serverId,
}: {
  active: boolean;
  compact?: boolean;
  member: VoiceLoungeMember;
  onFocus: () => void;
  serverId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const speaking = useMediaStore((state) => state.speakingUserIds.has(profile.userId));
  const muted = voice.muted || voice.deafened;
  const renderMembers = useMemo(
    () => [
      {
        userId: profile.userId,
        color: profile.color,
        muted,
        ...(profile.voiceAvatar === undefined ? {} : { voiceAvatar: profile.voiceAvatar }),
      },
    ],
    [muted, profile.color, profile.userId, profile.voiceAvatar],
  );
  const rendererState = useVoiceAvatarStage({ active, canvasRef, members: renderMembers });

  return (
    <button
      type="button"
      data-testid={`voice-avatar-tile-${profile.userId}`}
      data-speaking={speaking ? "true" : "false"}
      data-muted={muted ? "true" : "false"}
      data-compact={compact ? "true" : "false"}
      data-renderer={rendererState}
      data-avatar-mode={profile.voiceAvatar === undefined ? "automatic" : "custom"}
      onClick={onFocus}
      className={cn(
        "group relative size-full min-h-0 overflow-hidden rounded-xl border bg-gradient-to-b from-muted/45 to-background/70 text-foreground transition-[border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none",
        speaking && !muted
          ? "border-green-500/80 shadow-[0_0_18px_rgba(34,197,94,0.28)]"
          : "border-border/70",
      )}
    >
      <span
        aria-hidden={true}
        className={cn(
          "absolute inset-0 z-0 flex items-center justify-center transition-opacity",
          rendererState === "ready" ? "opacity-0" : "opacity-100",
        )}
      >
        <span
          className={cn(
            "flex items-center justify-center rounded-full font-semibold text-white shadow-lg",
            compact ? "size-16 text-xl" : "size-24 text-3xl",
          )}
          style={{ backgroundColor: profile.color }}
        >
          {profile.displayName.charAt(0).toUpperCase()}
        </span>
      </span>
      <canvas
        ref={canvasRef}
        aria-hidden={true}
        className={cn(
          "pointer-events-none absolute inset-0 z-10 size-full transition-opacity",
          rendererState === "ready" ? "opacity-100" : "opacity-0",
        )}
      />
      <span
        className={cn(
          "absolute inset-x-2 bottom-2 z-20 flex items-center justify-center gap-1.5 rounded-md bg-background/75 font-medium backdrop-blur-sm",
          compact ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
        )}
      >
        <span className="truncate">{profile.displayName}</span>
        {profile.marketIcon === undefined ? null : (
          <MarketIcon
            serverId={serverId}
            itemId={profile.marketIcon.itemId}
            name={profile.marketIcon.name}
          />
        )}
        {speaking && !muted ? (
          <AudioLinesIcon className="size-3.5 shrink-0 text-green-500" aria-hidden={true} />
        ) : null}
      </span>
      {muted ? (
        <span className="absolute top-2 right-2 z-20 flex size-7 items-center justify-center rounded-full bg-background/80 text-muted-foreground backdrop-blur-sm">
          <MicOffIcon className="size-4" aria-hidden={true} />
        </span>
      ) : null}
    </button>
  );
}
