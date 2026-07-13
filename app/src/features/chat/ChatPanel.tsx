import { ChatDropZone } from "./ChatDropZone";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { PollRail } from "@/features/polls/PollRail";

// Chat is the persistent right-hand panel. Workspace navigation belongs to the center column, so
// this component deliberately has no tab state or header strip.
export function ChatPanel({ serverId }: { serverId: string }) {
  return (
    <section data-testid="chat-panel" className="flex h-full min-h-0 flex-col">
      <ChatDropZone serverId={serverId}>
        <PollRail serverId={serverId} />
        <MessageList serverId={serverId} active />
        <Composer serverId={serverId} />
      </ChatDropZone>
    </section>
  );
}
