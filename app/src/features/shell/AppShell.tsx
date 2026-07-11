import type { CSSProperties } from "react";
import { ChatTabs } from "@/features/chat/ChatTabs";
import { ChannelsPanel } from "@/features/servers/ChannelsPanel";
import { PeoplePanel } from "@/features/servers/PeoplePanel";
import { Canvas } from "@/features/streams/Canvas";
import { ControlsBar } from "./ControlsBar";
import { CostBanner } from "./CostBanner";
import { Header } from "./Header";

// The persistent app shell laid out exactly per §7.6. Pinned CSS grid: header spans all columns; the
// left column (rows 2–3) stacks Channels over People; the center splits into a canvas slot (row 2) and
// a controls slot (row 3); the right column (rows 2–3) holds the tabs slot (the soundboard now lives as
// a tab inside ChatTabs — temporary, pending restructure). Slots are filled by S6.1/S7.3/S8.2/S9.1.
const GRID: CSSProperties = {
  display: "grid",
  gridTemplateRows: "40px 1fr 56px",
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
      <Header />
      <div style={{ gridArea: "left" }} className="flex min-h-0 flex-col border-r bg-card">
        <ChannelsPanel serverId={serverId} />
        <PeoplePanel serverId={serverId} />
      </div>
      <div
        data-testid="slot-canvas"
        style={{ gridArea: "canvas" }}
        className="min-h-0 overflow-hidden"
      >
        <Canvas />
      </div>
      <div
        data-testid="slot-controls"
        style={{ gridArea: "controls" }}
        className="border-t bg-card"
      >
        <ControlsBar serverId={serverId} />
      </div>
      <div style={{ gridArea: "right" }} className="flex min-h-0 flex-col border-l bg-card">
        <div data-testid="slot-tabs" className="min-h-0 flex-1 overflow-hidden">
          <ChatTabs serverId={serverId} />
        </div>
      </div>
    </div>
  );
}
