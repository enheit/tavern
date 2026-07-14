import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TavernHome } from "@/features/home/TavernHome";
import { RecordingsTab } from "@/features/recordings/RecordingsTab";
import { ScreenshotsTab } from "@/features/screenshots/ScreenshotsTab";
import { SoundboardPanel } from "@/features/soundboard/SoundboardPanel";
import { PollsTab } from "@/features/polls/PollsTab";
import { MarketTab } from "@/features/market/MarketTab";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { Canvas } from "./Canvas";

type WorkspaceView =
  | "dashboard"
  | "stream"
  | "recordings"
  | "screenshots"
  | "soundboard"
  | "polls"
  | "market";

function isWorkspaceView(value: unknown): value is WorkspaceView {
  return (
    value === "dashboard" ||
    value === "stream" ||
    value === "recordings" ||
    value === "screenshots" ||
    value === "soundboard" ||
    value === "polls" ||
    value === "market"
  );
}

// Owns all center-column navigation. Dashboard and Stream stay mounted while hidden so dashboard
// queries retain their state and watched stream sessions are not disconnected by tab changes.
export function WorkspaceTabs({ serverId }: { serverId: string }) {
  const store = roomStore(serverId);
  const streams = useStore(store, (state) => state.streams);
  const voiceMembers = useStore(store, (state) => state.voice.members);
  const webcamUserIds = new Set(
    streams.filter((stream) => stream.kind === "webcam").map((stream) => stream.userId),
  );
  const voiceMemberCount = voiceMembers.filter(
    (member) => !webcamUserIds.has(member.userId),
  ).length;
  const participantCount = streams.length + voiceMemberCount;
  const hasParticipants = participantCount > 0;
  const [view, setView] = useState<WorkspaceView>(() => (hasParticipants ? "stream" : "dashboard"));
  const previousParticipantCountRef = useRef(participantCount);

  useEffect(() => {
    const previousCount = previousParticipantCountRef.current;
    if (participantCount > previousCount) setView("stream");
    else if (participantCount === 0) {
      setView((current) => (current === "stream" ? "dashboard" : current));
    }
    previousParticipantCountRef.current = participantCount;
  }, [participantCount]);

  return (
    <Tabs
      data-testid="workspace"
      value={view}
      onValueChange={(value) => {
        if (isWorkspaceView(value) && (value !== "stream" || hasParticipants)) setView(value);
      }}
      className="h-full w-full gap-0 bg-background"
    >
      <div className="relative z-10 shrink-0 bg-background">
        <TabsList
          variant="chip"
          aria-label={m.workspace_label()}
          className="relative w-full justify-start overflow-x-auto rounded-none bg-transparent p-2 [&>*]:flex-none"
        >
          <TabsTrigger value="dashboard" data-testid="workspace-tab-dashboard">
            {m.canvas_dashboard()}
          </TabsTrigger>
          {hasParticipants ? (
            <TabsTrigger value="stream" data-testid="workspace-tab-stream">
              {m.canvas_stream()}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="recordings" data-testid="workspace-tab-recordings">
            {m.tabs_recordings()}
          </TabsTrigger>
          <TabsTrigger value="screenshots" data-testid="workspace-tab-screenshots">
            {m.tabs_screenshots()}
          </TabsTrigger>
          <TabsTrigger value="soundboard" data-testid="workspace-tab-soundboard">
            {m.soundboard_title()}
          </TabsTrigger>
          <TabsTrigger value="polls" data-testid="workspace-tab-polls">
            {m.polls_title()}
          </TabsTrigger>
          <TabsTrigger value="market" data-testid="workspace-tab-market">
            {m.market_title()}
          </TabsTrigger>
        </TabsList>
        <div
          aria-hidden={true}
          className="pointer-events-none absolute inset-x-0 -bottom-4 h-4 bg-gradient-to-b from-background to-transparent"
        />
      </div>

      <TabsContent
        value="dashboard"
        keepMounted
        className="flex h-full min-h-0 flex-col overflow-hidden"
      >
        <TavernHome
          serverId={serverId}
          active={view === "dashboard"}
          onOpenSoundboard={() => setView("soundboard")}
        />
      </TabsContent>
      {hasParticipants ? (
        <TabsContent
          value="stream"
          keepMounted
          className="flex h-full min-h-0 flex-col overflow-hidden"
        >
          <Canvas serverId={serverId} active={view === "stream"} />
        </TabsContent>
      ) : null}
      <TabsContent value="recordings" className="flex h-full min-h-0 flex-col overflow-hidden">
        <RecordingsTab serverId={serverId} />
      </TabsContent>
      <TabsContent value="screenshots" className="flex h-full min-h-0 flex-col overflow-hidden">
        <ScreenshotsTab serverId={serverId} />
      </TabsContent>
      <TabsContent value="soundboard" className="flex h-full min-h-0 flex-col overflow-hidden">
        <SoundboardPanel serverId={serverId} />
      </TabsContent>
      <TabsContent value="polls" className="flex h-full min-h-0 flex-col overflow-hidden">
        <PollsTab serverId={serverId} />
      </TabsContent>
      <TabsContent value="market" className="flex h-full min-h-0 flex-col overflow-hidden">
        <MarketTab serverId={serverId} />
      </TabsContent>
    </Tabs>
  );
}
