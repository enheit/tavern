import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppShell } from "@/features/shell/AppShell";
import { resetRoomStores } from "@/stores/room";
import { useServersStore } from "@/stores/servers";

beforeEach(() => {
  resetRoomStores();
  useServersStore.setState({ servers: [], activeServerId: "s1", connState: {} });
});

afterEach(() => {
  cleanup();
});

describe("shell layout", () => {
  it("renders pinned grid template and named slots", () => {
    render(
      <MemoryRouter>
        <AppShell serverId="s1" />
      </MemoryRouter>,
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell.style.gridTemplateRows).toBe("40px 1fr 56px");
    expect(shell.style.gridTemplateColumns).toBe("240px 1fr 320px");

    // Every §7.6 region is present as a named slot/panel, ready for later steps to fill.
    for (const id of [
      "app-header",
      "channels-panel",
      "people-panel",
      "slot-canvas",
      "slot-controls",
      "slot-tabs",
      "slot-soundboard",
    ]) {
      expect(screen.getByTestId(id)).toBeDefined();
    }
  });
});
