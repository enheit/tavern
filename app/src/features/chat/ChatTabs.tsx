import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivityTab } from "@/features/activity/ActivityTab";
import { RecordingsTab } from "@/features/recordings/RecordingsTab";
import { m } from "@/paraglide/messages.js";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

// The right-column tabs slot (§7.6, order Chat·Activity·Stats·Recordings). Chat + Activity + Recordings
// render content; Stats stays a placeholder until S10.2.
function ComingSoon() {
  return (
    <div
      data-testid="coming-soon"
      className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
    >
      {m.common_coming_soon()}
    </div>
  );
}

export function ChatTabs({ serverId }: { serverId: string }) {
  return (
    <Tabs
      data-testid="chat-tabs"
      defaultValue="chat"
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList variant="line" className="h-9 shrink-0 justify-start gap-1 px-2 pt-2">
        <TabsTrigger value="chat" data-testid="tab-chat">
          {m.tabs_chat()}
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
      </TabsList>
      <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
        <MessageList serverId={serverId} />
        <Composer serverId={serverId} />
      </TabsContent>
      <TabsContent value="activity" className="min-h-0 flex-1">
        <ActivityTab serverId={serverId} />
      </TabsContent>
      <TabsContent value="stats" className="min-h-0 flex-1">
        <ComingSoon />
      </TabsContent>
      <TabsContent value="recordings" className="min-h-0 flex-1">
        <RecordingsTab serverId={serverId} />
      </TabsContent>
    </Tabs>
  );
}
