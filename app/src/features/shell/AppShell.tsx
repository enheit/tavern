import type { CSSProperties } from "react";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { ChannelsPanel } from "@/features/servers/ChannelsPanel";
import { WorkspaceTabs } from "@/features/streams/WorkspaceTabs";
import { VolumeHud } from "@/features/volume/VolumeHud";
import { VoicePanel } from "@/features/voice/VoicePanel";
import { useMediaStore } from "@/stores/media";
import { ControlsBar } from "./ControlsBar";
import { CostBanner } from "./CostBanner";
import { Header } from "./Header";
import { SidebarProfile } from "./SidebarProfile";

// The persistent app shell laid out per §7.6. The header spans all columns; the left column holds
// Channels and voice controls; the center holds workspace navigation and gains the controls row only
// for an active voice session; the right column is persistent chat.
const GRID_WITH_CONTROLS: CSSProperties = {
  display: "grid",
  gridTemplateRows: "40px 1fr 64px",
  gridTemplateColumns: "240px 1fr 320px",
  gridTemplateAreas: [
    '"header header header"',
    '"left canvas right"',
    '"left controls right"',
  ].join(" "),
};

const GRID_WITHOUT_CONTROLS: CSSProperties = {
  display: "grid",
  gridTemplateRows: "40px 1fr",
  gridTemplateColumns: "240px 1fr 320px",
  gridTemplateAreas: ['"header header header"', '"left canvas right"'].join(" "),
};

export function AppShell({ serverId }: { serverId: string }) {
  const showControls = useMediaStore(
    (state) => state.voiceStatus === "joined" && state.inVoiceServerId === serverId,
  );

  return (
    <div
      data-testid="app-shell"
      style={showControls ? GRID_WITH_CONTROLS : GRID_WITHOUT_CONTROLS}
      className="relative h-screen w-screen overflow-hidden"
    >
      {/* §8 G5 warn banner (S12.3) — absolute overlay across the header; grid rows stay pinned. */}
      <CostBanner serverId={serverId} />
      {/* Center-screen per-target volume feedback (scroll on a nickname / stream tile). */}
      <VolumeHud />
      <Header />
      <div style={{ gridArea: "left" }} className="flex min-h-0 flex-col border-r bg-card">
        <ChannelsPanel serverId={serverId} />
        <div className="min-h-0 flex-1" />
        {/* Voice leave control sits directly above the persistent self-profile control. */}
        <VoicePanel serverId={serverId} />
        <SidebarProfile serverId={serverId} />
      </div>
      <div
        data-testid="slot-canvas"
        style={{ gridArea: "canvas" }}
        className="min-h-0 overflow-hidden"
      >
        <WorkspaceTabs key={serverId} serverId={serverId} />
      </div>
      {showControls ? (
        <div
          data-testid="slot-controls"
          style={{ gridArea: "controls" }}
          className="relative z-10 bg-card"
        >
          <div
            aria-hidden={true}
            className="pointer-events-none absolute inset-x-0 -top-4 h-4 bg-gradient-to-b from-transparent to-card"
          />
          <ControlsBar serverId={serverId} />
        </div>
      ) : null}
      <div style={{ gridArea: "right" }} className="flex min-h-0 flex-col border-l bg-card">
        <div data-testid="slot-chat" className="min-h-0 flex-1 overflow-hidden">
          <ChatPanel serverId={serverId} />
        </div>
      </div>
    </div>
  );
}
