import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivityTab } from "@/features/activity/ActivityTab";
import { RecordingsTab } from "@/features/recordings/RecordingsTab";
import { ScreenshotsTab } from "@/features/screenshots/ScreenshotsTab";
import { PeoplePanel } from "@/features/servers/PeoplePanel";
import { SoundboardPanel } from "@/features/soundboard/SoundboardPanel";
import { StatsTab } from "@/features/stats/StatsTab";
import { m } from "@/paraglide/messages.js";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

// The right-column tabs slot (§7.6, order Chat·Activity·Stats·Recordings). Controlled so the Stats
// pane can gate its query on activeness: its panel stays mounted (`keepMounted`) and `StatsTab`'s
// query is `enabled` only while `stats` is the active tab (FR-40 refetch-on-activation, S10.2).
export function ChatTabs({ serverId }: { serverId: string }) {
  const [tab, setTab] = useState("chat");
  return (
    <Tabs
      data-testid="chat-tabs"
      value={tab}
      onValueChange={(value) => setTab(String(value))}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      {/* Temp: tabs overflow the narrow right column, so the list scrolls horizontally.
          `flex-none` on triggers keeps their natural width (overriding the base `flex-1`) so
          they overflow into the scroll rather than shrinking to fit. Scrollbar hidden for a
          cleaner strip. To be restructured. */}
      <TabsList
        variant="chip"
        className="w-full shrink-0 [scrollbar-width:none] justify-start overflow-x-auto p-2 [&::-webkit-scrollbar]:hidden [&>*]:flex-none"
      >
        <TabsTrigger value="chat" data-testid="tab-chat">
          {m.tabs_chat()}
        </TabsTrigger>
        <TabsTrigger value="people" data-testid="tab-people">
          {m.people_title()}
        </TabsTrigger>
        <TabsTrigger value="activity" data-testid="tab-activity">
          {m.tabs_activity()}
        </TabsTrigger>
        <TabsTrigger value="stats" data-testid="tab-stats">
          {m.tabs_stats()}
        </TabsTrigger>
        <TabsTrigger value="recordings" data-testid="tab-recordings">
          {m.tabs_recordings()}
        </TabsTrigger>
        <TabsTrigger value="screenshots" data-testid="tab-screenshots">
          {m.tabs_screenshots()}
        </TabsTrigger>
        <TabsTrigger value="soundboard" data-testid="tab-soundboard">
          {m.soundboard_title()}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
        <MessageList serverId={serverId} />
        <Composer serverId={serverId} />
      </TabsContent>
      {/* People temporarily lives as a tab (moved out from under the channels list); will be
          restructured. Reuses the existing `people_title` message for the label. */}
      <TabsContent value="people" className="min-h-0 flex-1">
        <PeoplePanel serverId={serverId} />
      </TabsContent>
      <TabsContent value="activity" className="min-h-0 flex-1">
        <ActivityTab serverId={serverId} />
      </TabsContent>
      <TabsContent value="stats" className="min-h-0 flex-1" keepMounted>
        <StatsTab serverId={serverId} active={tab === "stats"} />
      </TabsContent>
      <TabsContent value="recordings" className="min-h-0 flex-1">
        <RecordingsTab serverId={serverId} />
      </TabsContent>
      <TabsContent value="screenshots" className="flex min-h-0 flex-1 flex-col">
        <ScreenshotsTab serverId={serverId} />
      </TabsContent>
      {/* Soundboard temporarily lives as a tab (moved out from under the chat); will be
          restructured. Reuses the existing `soundboard_title` message for the label. */}
      <TabsContent value="soundboard" className="min-h-0 flex-1">
        <SoundboardPanel serverId={serverId} />
      </TabsContent>
    </Tabs>
  );
}
