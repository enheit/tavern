import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TavernHome } from "@/features/home/TavernHome";
import { RecordingsTab } from "@/features/recordings/RecordingsTab";
import { ScreenshotsTab } from "@/features/screenshots/ScreenshotsTab";
import { SoundboardPanel } from "@/features/soundboard/SoundboardPanel";
import { PollsTab } from "@/features/polls/PollsTab";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { Canvas } from "./Canvas";

type WorkspaceView = "dashboard" | "stream" | "recordings" | "screenshots" | "soundboard" | "polls";

function isWorkspaceView(value: unknown): value is WorkspaceView {
  return (
    value === "dashboard" ||
    value === "stream" ||
    value === "recordings" ||
    value === "screenshots" ||
    value === "soundboard" ||
    value === "polls"
  );
}

// Owns all center-column navigation. Dashboard and Stream stay mounted while hidden so dashboard
// queries retain their state and watched stream sessions are not disconnected by tab changes.
export function WorkspaceTabs({ serverId }: { serverId: string }) {
  const streams = useStore(roomStore(serverId), (state) => state.streams);
  const hasStreams = streams.length > 0;
  const [view, setView] = useState<WorkspaceView>(() => (hasStreams ? "stream" : "dashboard"));
  const previousStreamCountRef = useRef(streams.length);

  useEffect(() => {
    const previousCount = previousStreamCountRef.current;
    if (streams.length > previousCount) setView("stream");
    else if (streams.length === 0) {
      setView((current) => (current === "stream" ? "dashboard" : current));
    }
    previousStreamCountRef.current = streams.length;
  }, [streams.length]);

  return (
    <Tabs
      data-testid="workspace"
      value={view}
      onValueChange={(value) => {
        if (isWorkspaceView(value) && (value !== "stream" || hasStreams)) setView(value);
      }}
      className="h-full w-full gap-0 bg-background"
    >
      <TabsList
        variant="chip"
        aria-label={m.workspace_label()}
        className="w-full shrink-0 justify-start overflow-x-auto rounded-none bg-background/95 p-2 [&>*]:flex-none"
      >
        <TabsTrigger value="dashboard" data-testid="workspace-tab-dashboard">
          {m.canvas_dashboard()}
        </TabsTrigger>
        {hasStreams ? (
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
      </TabsList>

      <TabsContent value="dashboard" keepMounted className="min-h-0">
        <TavernHome serverId={serverId} onOpenSoundboard={() => setView("soundboard")} />
      </TabsContent>
      {hasStreams ? (
        <TabsContent value="stream" keepMounted className="min-h-0">
          <Canvas serverId={serverId} active={view === "stream"} />
        </TabsContent>
      ) : null}
      <TabsContent value="recordings" className="min-h-0">
        <RecordingsTab serverId={serverId} />
      </TabsContent>
      <TabsContent value="screenshots" className="min-h-0">
        <ScreenshotsTab serverId={serverId} />
      </TabsContent>
      <TabsContent value="soundboard" className="min-h-0">
        <SoundboardPanel serverId={serverId} />
      </TabsContent>
      <TabsContent value="polls" className="min-h-0">
        <PollsTab serverId={serverId} />
      </TabsContent>
    </Tabs>
  );
}
