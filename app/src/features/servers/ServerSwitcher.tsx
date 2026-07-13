import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useNavigate } from "react-router";
import { useStore } from "zustand";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { useServersStore } from "@/stores/servers";
import { roomStore } from "@/stores/room";

function ServerUnread({ serverId }: { serverId: string }) {
  const count = useStore(roomStore(serverId), (state) => state.unreadCount);
  if (count === 0) return null;
  return (
    <span
      data-testid={`server-unread-${serverId}`}
      className="ml-auto min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 text-white"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

// FR-41 server switcher in the header: the trigger shows the active server nickname (or a placeholder)
// and items are the joined servers (active one check-marked) navigating /s/:id. One-server-per-user
// means there is no "join or create" entry here — /join is reachable only by an account with no server.
export function ServerSwitcher() {
  const navigate = useNavigate();
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const active = servers.find((s) => s.id === activeServerId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="server-switcher"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "max-w-56 gap-1.5")}
      >
        <span data-testid="active-server-name" className="truncate">
          {active !== null ? active.nickname : m.servers_switcher_none()}
        </span>
        <ChevronsUpDownIcon className="shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {servers.map((server) => (
          <DropdownMenuItem
            key={server.id}
            data-testid={`server-item-${server.id}`}
            onClick={() => navigate(`/s/${server.id}`)}
          >
            <span className="truncate">{server.nickname}</span>
            <ServerUnread serverId={server.id} />
            {server.id === activeServerId && (
              <CheckIcon data-testid={`server-check-${server.id}`} className="ml-auto" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
