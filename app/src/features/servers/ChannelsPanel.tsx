import { HashIcon, Volume2Icon } from "lucide-react";
import { m } from "@/paraglide/messages.js";

// The left-column channel list (§7.6). FR-13: the schema is multi-channel-ready but v1 renders exactly
// the two default channels — one voice, one text — both inert here (voice wiring lands in S7.3, text in
// S6.1).
export function ChannelsPanel() {
  return (
    <nav data-testid="channels-panel" className="flex flex-col gap-0.5 p-2">
      <h2 className="px-1 py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {m.channels_title()}
      </h2>
      <div
        data-testid="channel-voice"
        className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground"
      >
        <Volume2Icon className="size-4 shrink-0" />
        <span className="truncate">{m.channels_voice()}</span>
      </div>
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
