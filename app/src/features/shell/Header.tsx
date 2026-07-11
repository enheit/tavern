import { LogOutIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ServerSettingsDialog } from "@/features/admin/ServerSettingsDialog";
import { useAuth } from "@/features/auth/useAuth";
import { ServerSwitcher } from "@/features/servers/ServerSwitcher";
import { UpdatePill } from "@/features/shell/UpdatePill";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { cn } from "@/lib/utils";
import type { WsStatus } from "@/lib/wsClient";
import { m } from "@/paraglide/messages.js";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";

// The pinned header (§7.6): server switcher (left), spacer, connection dot, user menu. Every child is
// driven by a store selector — no props.
export function Header() {
  return (
    <header
      data-testid="app-header"
      className="col-span-full flex items-center gap-2 border-b bg-card px-2"
    >
      <ServerSwitcher />
      <div className="flex-1" />
      <UpdatePill />
      <AdminSettings />
      <ConnectionDot />
      <UserMenu />
    </header>
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

// FR-11 client-side logout + the FR-16/settings entry point (opens the controlled SettingsDialog).
function UserMenu() {
  const { logout } = useAuth();
  const profile = useSessionStore((s) => s.profile);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const initial = profile !== null ? profile.displayName.charAt(0) : "";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="user-menu"
          aria-label={m.settings_title()}
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "rounded-full")}
        >
          <span
            className="flex size-6 items-center justify-center rounded-full text-xs font-medium text-white"
            style={{ backgroundColor: profile?.color ?? "#71717a" }}
          >
            {initial}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="user-menu-settings" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon />
            {m.shell_user_menu_settings()}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="user-menu-logout"
            onClick={() => {
              void logout();
            }}
          >
            <LogOutIcon />
            {m.shell_user_menu_logout()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
