import { LIMITS } from "@tavern/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { ServerSettingsDialog } from "@/features/admin/ServerSettingsDialog";
import { ServerSwitcher } from "@/features/servers/ServerSwitcher";
import { UpdatePill } from "@/features/shell/UpdatePill";
import { cn } from "@/lib/utils";
import type { WsStatus } from "@/lib/wsClient";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";

// The pinned header (§7.6): server switcher, connection status, updates, and server administration.
export function Header() {
  return (
    <header
      data-testid="app-header"
      className="col-span-full grid grid-cols-3 items-center gap-2 border-b bg-card px-2"
    >
      {/* Three equal 1fr columns: the center cell is truly header-centered regardless of how wide the
          left (server switcher) or right (controls) groups are — the status no longer drifts. */}
      <div className="flex min-w-0 items-center gap-2 justify-self-start">
        <ServerSwitcher />
      </div>
      <div className="flex min-w-0 items-center justify-center">
        <ServerStatus />
      </div>
      <div className="flex items-center gap-2 justify-self-end">
        <UpdatePill />
        <AdminSettings />
        <ConnectionDot />
      </div>
    </header>
  );
}

// §header status: the shared, inline-editable server status, centered in the header. Gated on an
// active server (its room store holds the live `status`). Anyone connected may edit it.
function ServerStatus() {
  const activeServerId = useServersStore((s) => s.activeServerId);
  if (activeServerId === null) return null;
  return <ServerStatusEditor serverId={activeServerId} />;
}

// Click the text → inline <input> seeded with the current status. Enter saves (fires `status.set`;
// the authoritative value returns via the `status.updated` broadcast). Escape or blur cancels. Empty
// status renders a muted placeholder. maxLength mirrors the wire cap (the DO re-validates + trims).
function ServerStatusEditor({ serverId }: { serverId: string }) {
  const status = useStore(roomStore(serverId), (s) => s.status);
  const setStatus = useStore(roomStore(serverId), (s) => s.setStatus);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Select-all on entering edit so the user can retype or extend the current status.
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-testid="server-status-input"
        value={draft}
        maxLength={LIMITS.statusMaxChars}
        placeholder={m.shell_status_placeholder()}
        aria-label={m.shell_status_edit_label()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            setStatus(draft);
            setEditing(false);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        onBlur={() => setEditing(false)}
        className="h-7 w-full max-w-md rounded-md border border-input bg-transparent px-2 text-center text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
      />
    );
  }

  return (
    <button
      type="button"
      data-testid="server-status"
      aria-label={m.shell_status_edit_label()}
      onClick={() => {
        setDraft(status);
        setEditing(true);
      }}
      className={cn(
        "max-w-md truncate rounded-md px-2 py-1 text-center text-sm hover:bg-accent hover:text-accent-foreground",
        status === "" && "text-muted-foreground",
      )}
    >
      {status === "" ? m.shell_status_placeholder() : status}
    </button>
  );
}

// FR-10/11/12 admin entry: renders the gear + ServerSettingsDialog for the active server; the dialog
// self-gates on admin (returns null for non-admins), so this just supplies the active serverId.
function AdminSettings() {
  const activeServerId = useServersStore((s) => s.activeServerId);
  if (activeServerId === null) return null;
  return <ServerSettingsDialog serverId={activeServerId} />;
}

// Connection state → pinned dot color + label (the label is the dot's title). Static record, no dynamic
// key construction (§9.6). Reads the SERVERS store connState for the active server (there is no
// room-store wsStatus). A server not yet in the map is shown as connecting.
const CONN_DOT: Record<WsStatus, string> = {
  open: "bg-green-500",
  connecting: "bg-amber-500",
  reconnecting: "bg-amber-500",
  closed: "bg-gray-400",
};
const CONN_LABEL: Record<WsStatus, () => string> = {
  open: () => m.shell_connection_connected(),
  connecting: () => m.shell_connection_connecting(),
  reconnecting: () => m.shell_connection_reconnecting(),
  closed: () => m.shell_connection_offline(),
};

function ConnectionDot() {
  const status = useServersStore((s): WsStatus => {
    const id = s.activeServerId;
    return id !== null ? (s.connState[id] ?? "connecting") : "connecting";
  });
  const label = CONN_LABEL[status]();
  return (
    <span
      data-testid="connection-dot"
      data-status={status}
      title={label}
      className={cn("size-2.5 shrink-0 rounded-full", CONN_DOT[status])}
    />
  );
}
