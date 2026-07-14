import type { Member, TavernHomeResponse as TavernHomeData } from "@tavern/shared";
import { TavernHomeResponse } from "@tavern/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AudioLinesIcon,
  Clock3Icon,
  CrownIcon,
  ImageIcon,
  MedalIcon,
  Mic2Icon,
  MonitorUpIcon,
  RadioIcon,
  TrophyIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { RecordingPlayer } from "@/features/recordings/RecordingPlayer";
import { UserProfileName } from "@/features/users/UserProfileName";
import { apiClient } from "@/lib/apiClient";
import { formatRelativeTime } from "@/lib/time";
import { connectRoom } from "@/lib/wsClient";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSettingsStore } from "@/stores/settings";

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

function homeKey(serverId: string): readonly [string, string] {
  return ["home", serverId];
}

export function TavernHome({
  serverId,
  onOpenSoundboard,
  active = true,
}: {
  serverId: string;
  onOpenSoundboard: (() => void) | undefined;
  active?: boolean;
}) {
  const store = roomStore(serverId);
  const members = useStore(store, (state) => state.members);
  const voice = useStore(store, (state) => state.voice);
  const streams = useStore(store, (state) => state.streams);
  const recording = useStore(store, (state) => state.recording);
  const locale = useSettingsStore((state) => state.locale);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: homeKey(serverId),
    queryFn: () => apiClient.get(`/api/servers/${serverId}/home`, TavernHomeResponse),
    enabled: active,
  });

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({
      queryKey: homeKey(serverId),
      refetchType: active ? "active" : "none",
    });
  }, [active, queryClient, serverId]);

  useEffect(() => {
    const connection = connectRoom(serverId);
    return combineCleanups([
      connection.on("hangout.updated", invalidate),
      connection.on("screenshot.updated", invalidate),
      connection.on("sound.updated", invalidate),
      connection.on("rec.state", invalidate),
      connection.on("points.updated", (message) => {
        queryClient.setQueryData<TavernHomeData>(homeKey(serverId), (current) =>
          current === undefined
            ? current
            : { ...current, pointLeaderboard: message.pointLeaderboard },
        );
      }),
    ]);
  }, [serverId, invalidate, queryClient]);

  const voiceMembers = useMemo(
    () =>
      voice.members.flatMap((voiceMember) => {
        const profile = members.find((member) => member.userId === voiceMember.userId);
        return profile === undefined ? [] : [{ profile, voice: voiceMember }];
      }),
    [members, voice.members],
  );

  return (
    <main data-testid="tavern-home" className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-5">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">{m.home_title()}</h1>
          <p className="text-sm text-muted-foreground">{m.home_subtitle()}</p>
        </header>

        <section
          data-testid="home-live-now"
          className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3"
        >
          <div className="flex size-9 items-center justify-center rounded-full bg-violet-500/10 text-violet-500">
            <RadioIcon className="size-4" />
          </div>
          <div className="min-w-32">
            <h2 className="text-sm font-semibold">{m.home_live_now()}</h2>
            <p className="text-xs text-muted-foreground">
              {voiceMembers.length === 0
                ? m.home_live_quiet()
                : m.home_live_count({ count: voiceMembers.length })}
            </p>
          </div>
          {voiceMembers.length > 0 && (
            <div className="flex -space-x-2" data-testid="home-live-avatars">
              {voiceMembers.slice(0, 8).map((member) => (
                <HomeAvatar key={member.profile.userId} member={member.profile} />
              ))}
            </div>
          )}
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            {streams.length > 0 && (
              <span className="flex items-center gap-1">
                <MonitorUpIcon className="size-3.5" />
                {m.home_stream_count({ count: streams.length })}
              </span>
            )}
            {recording.active && (
              <span className="flex items-center gap-1 text-red-500">
                <span className="size-2 rounded-full bg-current" />
                {m.home_recording_live()}
              </span>
            )}
          </div>
        </section>

        {query.isPending ? (
          <div
            data-testid="home-loading"
            className="h-56 animate-pulse rounded-xl border bg-muted/30"
          />
        ) : query.isError || query.data === undefined ? (
          <div className="rounded-xl border p-6 text-sm text-muted-foreground">
            {m.home_unavailable()}
          </div>
        ) : (
          <HomeContent
            serverId={serverId}
            data={query.data}
            members={members}
            locale={locale}
            onOpenSoundboard={onOpenSoundboard}
          />
        )}
      </div>
    </main>
  );
}

function HomeContent({
  serverId,
  data,
  members,
  locale,
  onOpenSoundboard,
}: {
  serverId: string;
  data: TavernHomeData;
  members: Member[];
  locale: string;
  onOpenSoundboard: (() => void) | undefined;
}) {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(260px,2fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Section title={m.home_recent_hangouts()} icon={<UsersIcon className="size-4" />}>
          {data.recentHangouts.length === 0 ? (
            <EmptyText>{m.home_no_hangouts()}</EmptyText>
          ) : (
            <ul className="divide-y">
              {data.recentHangouts.map((hangout) => (
                <li key={hangout.id} data-testid={`home-hangout-${hangout.id}`} className="p-3">
                  <div className="flex items-center gap-3">
                    <div className="flex -space-x-2">
                      {hangout.participantIds.slice(0, 4).map((id) => {
                        const member = members.find((candidate) => candidate.userId === id);
                        return member ? <HomeAvatar key={id} member={member} /> : null;
                      })}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {m.home_hung_out({
                          names: participantNames(hangout.participantIds, members),
                        })}
                      </p>
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock3Icon className="size-3" />
                        {formatDuration(hangout.sharedDurationMs)} ·{" "}
                        {formatRelativeTime(hangout.endedAt, locale)}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <MembersSection serverId={serverId} members={members} />
        <PointsLeaderboard serverId={serverId} data={data} members={members} locale={locale} />
      </div>

      <aside className="flex min-w-0 flex-col gap-4">
        <LatestScreenshot serverId={serverId} data={data} members={members} locale={locale} />
        <LatestRecording serverId={serverId} data={data} members={members} />
        <LatestSound data={data} members={members} onOpenSoundboard={onOpenSoundboard} />
      </aside>
    </div>
  );
}

function PointsLeaderboard({
  serverId,
  data,
  members,
  locale,
}: {
  serverId: string;
  data: TavernHomeData;
  members: Member[];
  locale: string;
}) {
  const ranked = data.pointLeaderboard.flatMap((entry) => {
    const member = members.find((candidate) => candidate.userId === entry.userId);
    return member === undefined ? [] : [{ member, balance: entry.balance }];
  });

  return (
    <Section title={m.home_points_leaderboard()} icon={<TrophyIcon className="size-4" />}>
      <ol data-testid="home-points-leaderboard" className="divide-y">
        {ranked.map(({ member, balance }, index) => {
          const rank = index + 1;
          return (
            <li key={member.userId} className="flex items-center gap-3 px-3 py-2.5">
              <RankMarker rank={rank} />
              <HomeAvatar member={member} />
              <UserProfileName
                serverId={serverId}
                member={member}
                className="flex-1 text-sm font-medium"
              />
              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {m.home_points({ count: balance.toLocaleString(locale) })}
              </span>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

function RankMarker({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <span
        data-testid="home-rank-1"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-500"
      >
        <CrownIcon className="size-4" />
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span
        data-testid="home-rank-2"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-400/15 text-slate-400"
      >
        <MedalIcon className="size-4" />
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span
        data-testid="home-rank-3"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-orange-600/15 text-orange-600"
      >
        <MedalIcon className="size-4" />
      </span>
    );
  }
  return (
    <span
      data-testid={`home-rank-${rank}`}
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground tabular-nums"
    >
      {rank}
    </span>
  );
}

function MembersSection({ serverId, members }: { serverId: string; members: Member[] }) {
  const online = members
    .filter((member) => member.presence !== "offline")
    .toSorted((a, b) => {
      if (a.presence !== b.presence) return a.presence === "in-voice" ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  const offline = members
    .filter((member) => member.presence === "offline")
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <Section title={m.home_members()} icon={<UsersIcon className="size-4" />}>
      <div className="grid gap-4 p-3 sm:grid-cols-2">
        <MemberGroup
          serverId={serverId}
          title={m.home_online({ count: online.length })}
          members={online}
          online
        />
        <MemberGroup
          serverId={serverId}
          title={m.home_offline({ count: offline.length })}
          members={offline}
        />
      </div>
    </Section>
  );
}

function MemberGroup({
  serverId,
  title,
  members,
  online = false,
}: {
  serverId: string;
  title: string;
  members: Member[];
  online?: boolean;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {members.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{m.home_no_members()}</p>
      ) : (
        <ul
          className="space-y-1"
          data-testid={online ? "home-members-online" : "home-members-offline"}
        >
          {members.map((member) => (
            <li
              key={member.userId}
              data-testid={`home-member-${member.userId}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50"
            >
              <span className="relative shrink-0">
                <HomeAvatar member={member} testId={`home-member-avatar-${member.userId}`} />
                <span
                  className={`absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-card ${
                    member.presence === "offline" ? "bg-gray-400" : "bg-green-500"
                  }`}
                />
              </span>
              <UserProfileName
                serverId={serverId}
                member={member}
                className="flex-1 text-sm font-medium"
                testId={`home-member-name-${member.userId}`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function LatestScreenshot({
  serverId,
  data,
  members,
  locale,
}: {
  serverId: string;
  data: TavernHomeData;
  members: Member[];
  locale: string;
}) {
  const screenshot = data.latestScreenshot;
  return (
    <Section title={m.home_latest_screenshot()} icon={<ImageIcon className="size-4" />}>
      {screenshot === null ? (
        <EmptyText>{m.home_no_screenshots()}</EmptyText>
      ) : (
        <div data-testid="home-latest-screenshot" className="p-3">
          <a
            href={`${API_BASE}/api/screenshots/${serverId}/${screenshot.id}.webp`}
            target="_blank"
            rel="noopener noreferrer"
            className="block overflow-hidden rounded-lg border bg-black"
          >
            <img
              src={`${API_BASE}/api/screenshots/${serverId}/${screenshot.id}.webp`}
              alt={m.screenshots_open()}
              className="aspect-video w-full object-cover"
            />
          </a>
          <p className="mt-2 truncate text-xs text-muted-foreground">
            {memberName(screenshot.capturedBy, members)} ·{" "}
            {formatRelativeTime(screenshot.createdAt, locale)}
          </p>
        </div>
      )}
    </Section>
  );
}

function LatestRecording({
  serverId,
  data,
  members,
}: {
  serverId: string;
  data: TavernHomeData;
  members: Member[];
}) {
  const recording = data.latestRecording;
  return (
    <Section title={m.home_latest_recording()} icon={<Mic2Icon className="size-4" />}>
      {recording === null ? (
        <EmptyText>{m.home_no_recordings()}</EmptyText>
      ) : (
        <div data-testid="home-latest-recording" className="p-3">
          <p className="mb-2 truncate text-xs text-muted-foreground">
            {m.home_recorded_by({ name: memberName(recording.startedBy, members) })}
          </p>
          <RecordingPlayer
            recordingId={recording.id}
            durationMs={recording.durationMs}
            url={`${API_BASE}/api/media/recordings/${serverId}/${recording.id}.webm`}
          />
        </div>
      )}
    </Section>
  );
}

function LatestSound({
  data,
  members,
  onOpenSoundboard,
}: {
  data: TavernHomeData;
  members: Member[];
  onOpenSoundboard: (() => void) | undefined;
}) {
  const sound = data.latestSound;
  return (
    <Section title={m.home_newest_sound()} icon={<AudioLinesIcon className="size-4" />}>
      {sound === null ? (
        <EmptyText>{m.home_no_sounds()}</EmptyText>
      ) : (
        <div data-testid="home-latest-sound" className="flex items-center gap-3 p-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-500">
            <AudioLinesIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{sound.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {memberName(sound.uploaderId, members)} ·{" "}
              {m.home_play_count({ count: sound.playCount })}
            </p>
          </div>
          {onOpenSoundboard !== undefined && (
            <Button size="sm" variant="secondary" onClick={onOpenSoundboard}>
              {m.home_open_soundboard()}
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

function EmptyText({ children }: { children: ReactNode }) {
  return <p className="p-4 text-sm text-muted-foreground">{children}</p>;
}

function HomeAvatar({ member, testId }: { member: Member; testId?: string }) {
  const [failed, setFailed] = useState(false);
  return failed || member.avatarKey === undefined ? (
    <span
      data-testid={testId}
      title={member.displayName}
      className="flex size-8 items-center justify-center rounded-full border-2 border-card text-xs font-semibold text-white"
      style={{ backgroundColor: member.color }}
    >
      {member.displayName.charAt(0).toUpperCase()}
    </span>
  ) : (
    <img
      data-testid={testId}
      src={`/api/media/avatars/${member.userId}.webp`}
      alt={member.displayName}
      title={member.displayName}
      onError={() => setFailed(true)}
      className="size-8 rounded-full border-2 border-card bg-muted object-cover"
    />
  );
}

function participantNames(ids: string[], members: Member[]): string {
  const names = ids.map((id) => memberName(id, members));
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function memberName(userId: string, members: Member[]): string {
  return (
    members.find((member) => member.userId === userId)?.displayName ?? m.activity_former_member()
  );
}

function formatDuration(durationMs: number): string {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function combineCleanups(cleanups: Array<() => void>): () => void {
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
