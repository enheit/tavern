import type { Member, VoiceMember } from "@tavern/shared";
import { AudioLinesIcon, MicOffIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { useMediaStore } from "@/stores/media";
import { MarketIcon } from "@/features/market/MarketIcon";
import { voiceLoungeColumns } from "./voiceAvatarScene";
import { useVoiceAvatarStage } from "./useVoiceAvatarStage";

export interface VoiceLoungeMember {
  profile: Member;
  voice: VoiceMember;
}

const LOUNGE_TITLE_ID = "voice-lounge-title";

// A single transparent WebGL canvas renders every head. The DOM tiles remain the accessible layer
// and own names, mute badges, and the coarse speaking highlight; the canvas is purely decorative.
export function VoiceLounge({
  members,
  active,
  serverId,
}: {
  members: VoiceLoungeMember[];
  active: boolean;
  serverId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const speakingUserIds = useMediaStore((state) => state.speakingUserIds);
  const columns = voiceLoungeColumns(members.length);
  const rows = columns === 0 ? 0 : Math.ceil(members.length / columns);
  const renderMembers = useMemo(
    () =>
      members.map(({ profile, voice }) => ({
        userId: profile.userId,
        color: profile.color,
        muted: voice.muted || voice.deafened,
        ...(profile.voiceAvatar === undefined ? {} : { voiceAvatar: profile.voiceAvatar }),
      })),
    [members],
  );
  const rendererState = useVoiceAvatarStage({ active, canvasRef, members: renderMembers });

  if (members.length === 0) return null;

  const fallbackVisible = rendererState !== "ready";
  const stageHeight = rows === 1 ? 224 : rows * 208;

  return (
    <section
      data-testid="voice-lounge"
      data-renderer={rendererState}
      className="overflow-hidden rounded-xl border bg-card"
      aria-labelledby={LOUNGE_TITLE_ID}
    >
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <div className="flex size-9 items-center justify-center rounded-full bg-violet-500/10 text-violet-500">
          <AudioLinesIcon className="size-4" />
        </div>
        <div>
          <h2 id={LOUNGE_TITLE_ID} className="text-sm font-semibold">
            {m.voice_lounge_title()}
          </h2>
          <p className="text-xs text-muted-foreground">
            {m.voice_lounge_count({ count: members.length })}
          </p>
        </div>
        <AudioLinesIcon className="ml-auto size-5 text-violet-500/70" aria-hidden={true} />
      </header>

      <div className="relative p-2" style={{ height: stageHeight }}>
        <div className="absolute inset-2 flex flex-wrap justify-center">
          {members.map(({ profile, voice }) => {
            const speaking = speakingUserIds.has(profile.userId);
            const muted = voice.muted || voice.deafened;
            return (
              <div
                key={profile.userId}
                className="relative p-1.5"
                style={{ flexBasis: `${100 / columns}%`, height: `${100 / rows}%` }}
              >
                <div
                  data-testid={`voice-lounge-avatar-${profile.userId}`}
                  data-speaking={speaking ? "true" : "false"}
                  data-muted={muted ? "true" : "false"}
                  data-avatar-mode={profile.voiceAvatar === undefined ? "automatic" : "custom"}
                  className={cn(
                    "relative h-full overflow-hidden rounded-xl border bg-gradient-to-b from-muted/45 to-background/70 transition-[border-color,box-shadow]",
                    speaking
                      ? "border-green-500/80 shadow-[0_0_18px_rgba(34,197,94,0.28)]"
                      : "border-border/70",
                  )}
                >
                  <div
                    aria-hidden={true}
                    className={cn(
                      "absolute inset-x-0 top-[18%] z-0 flex justify-center transition-opacity",
                      fallbackVisible ? "opacity-100" : "opacity-0",
                    )}
                  >
                    <span
                      className="flex size-20 items-center justify-center rounded-full text-2xl font-semibold text-white shadow-lg"
                      style={{ backgroundColor: profile.color }}
                    >
                      {profile.displayName.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="absolute inset-x-2 bottom-2 z-20 flex items-center justify-center gap-1.5 rounded-md bg-background/75 px-2 py-1 text-xs font-medium backdrop-blur-sm">
                    <span className="truncate">{profile.displayName}</span>
                    {profile.marketIcon === undefined ? null : (
                      <MarketIcon
                        serverId={serverId}
                        itemId={profile.marketIcon.itemId}
                        name={profile.marketIcon.name}
                      />
                    )}
                    {speaking && !muted ? (
                      <AudioLinesIcon
                        className="size-3.5 shrink-0 text-green-500"
                        aria-hidden={true}
                      />
                    ) : null}
                  </div>
                  {muted ? (
                    <span
                      className="absolute top-2 right-2 z-20 flex size-6 items-center justify-center rounded-full bg-background/80 text-muted-foreground backdrop-blur-sm"
                      aria-label={m.voice_lounge_muted({ name: profile.displayName })}
                    >
                      <MicOffIcon className="size-3.5" />
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <canvas
          ref={canvasRef}
          data-testid="voice-lounge-canvas"
          aria-hidden={true}
          className={cn(
            "pointer-events-none absolute inset-2 z-10 size-[calc(100%-1rem)] transition-opacity",
            rendererState === "ready" ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    </section>
  );
}
