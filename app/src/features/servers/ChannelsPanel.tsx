import { VoiceChannelRow } from "@/features/voice/VoiceChannelRow";
import { m } from "@/paraglide/messages.js";

// The left-column channel list (§7.6). FR-13: the schema is multi-channel-ready but v1 renders only the
// single live voice channel (S7.3 VoiceChannelRow). The text channel is implicit — the app assumes one
// chat, so no inert #general row is rendered.
export function ChannelsPanel({ serverId }: { serverId: string }) {
  return (
    <nav data-testid="channels-panel" className="flex flex-col gap-0.5 p-2">
      <h2 className="px-1 py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {m.channels_title()}
      </h2>
      <VoiceChannelRow serverId={serverId} />
    </nav>
  );
}
