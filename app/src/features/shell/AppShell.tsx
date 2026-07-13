import type { CSSProperties } from "react";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { ChannelsPanel } from "@/features/servers/ChannelsPanel";
import { WorkspaceTabs } from "@/features/streams/WorkspaceTabs";
import { VolumeHud } from "@/features/volume/VolumeHud";
import { VoicePanel } from "@/features/voice/VoicePanel";
import { ControlsBar } from "./ControlsBar";
import { CostBanner } from "./CostBanner";
import { Header } from "./Header";

// The persistent app shell laid out exactly per §7.6. Pinned CSS grid: header spans all columns; the
// left column holds Channels and voice controls; the center holds workspace navigation over the
// controls row; the right column is persistent chat.
const GRID: CSSProperties = {
  display: "grid",
  gridTemplateRows: "40px 1fr 64px",
  gridTemplateColumns: "240px 1fr 320px",
  gridTemplateAreas: [
    '"header header header"',
    '"left canvas right"',
    '"left controls right"',
  ].join(" "),
};

export function AppShell({ serverId }: { serverId: string }) {
  return (
    <div
      data-testid="app-shell"
      style={GRID}
      className="relative h-screen w-screen overflow-hidden"
    >
      {/* §8 G5 warn banner (S12.3) — absolute overlay across the header; grid rows stay pinned. */}
      <CostBanner serverId={serverId} />
      {/* Center-screen per-target volume feedback (scroll on a nickname / stream tile). */}
      <VolumeHud />
      <Header serverId={serverId} />
      <div style={{ gridArea: "left" }} className="flex min-h-0 flex-col border-r bg-card">
        <ChannelsPanel serverId={serverId} />
        <div className="min-h-0 flex-1" />
        {/* Discord-style voice controls pinned to the very bottom — only while connected to voice. */}
        <VoicePanel serverId={serverId} />
      </div>
      <div
        data-testid="slot-canvas"
        style={{ gridArea: "canvas" }}
        className="min-h-0 overflow-hidden"
      >
        <WorkspaceTabs key={serverId} serverId={serverId} />
      </div>
      <div data-testid="slot-controls" style={{ gridArea: "controls" }} className="bg-card">
        <ControlsBar serverId={serverId} />
      </div>
      <div style={{ gridArea: "right" }} className="flex min-h-0 flex-col border-l bg-card">
        <div data-testid="slot-chat" className="min-h-0 flex-1 overflow-hidden">
          <ChatPanel serverId={serverId} />
        </div>
      </div>
    </div>
  );
}
