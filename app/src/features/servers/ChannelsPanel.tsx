import { HashIcon } from "lucide-react";
import { VoiceChannelRow } from "@/features/voice/VoiceChannelRow";
import { m } from "@/paraglide/messages.js";

// The left-column channel list (§7.6). FR-13: the schema is multi-channel-ready but v1 renders exactly
// the two default channels — one voice (live, S7.3 VoiceChannelRow), one text (inert, S6.1 owns chat).
export function ChannelsPanel({ serverId }: { serverId: string }) {
  return (
    <nav data-testid="channels-panel" className="flex flex-col gap-0.5 p-2">
      <h2 className="px-1 py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {m.channels_title()}
      </h2>
      <VoiceChannelRow serverId={serverId} />
      <div
        data-testid="channel-general"
        className="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
      >
        <HashIcon className="size-4 shrink-0" />
        <span className="truncate">{m.channels_general()}</span>
      </div>
    </nav>
  );
}
