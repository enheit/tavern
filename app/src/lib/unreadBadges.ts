import { platform } from "@/platform/types";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";

let unreadFavicon: string | null = null;

async function buildUnreadFavicon(): Promise<string> {
  if (unreadFavicon !== null) return unreadFavicon;
  const image = new Image();
  image.src = "/favicon.png";
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("favicon canvas unavailable");
  context.drawImage(image, 0, 0, 64, 64);
  context.fillStyle = "#dc2626";
  context.beginPath();
  context.arc(52, 12, 11, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = "white";
  context.stroke();
  unreadFavicon = canvas.toDataURL("image/png");
  return unreadFavicon;
}

function updateDocumentBadge(count: number): void {
  if (typeof document === "undefined") return;
  document.title = count > 0 ? `(${count}) Tavern` : "Tavern";
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link === null) return;
  if (count === 0) {
    link.href = "/favicon.png";
    return;
  }
  void buildUnreadFavicon()
    .then((href) => {
      if (document.title.startsWith("(")) link.href = href;
    })
    .catch((error: unknown) => console.error("failed to build unread favicon", error));
}

export function initUnreadBadges(): () => void {
  const roomUnsubscribers = new Map<string, () => void>();
  const sync = (): void => {
    const count = useServersStore
      .getState()
      .servers.reduce((total, server) => total + roomStore(server.id).getState().unreadCount, 0);
    platform.shell.setBadge(count > 0 ? count : null);
    updateDocumentBadge(count);
  };
  const attach = (): void => {
    const serverIds = new Set(useServersStore.getState().servers.map((server) => server.id));
    for (const serverId of serverIds) {
      if (roomUnsubscribers.has(serverId)) continue;
      roomUnsubscribers.set(serverId, roomStore(serverId).subscribe(sync));
    }
    for (const [serverId, unsubscribe] of roomUnsubscribers) {
      if (serverIds.has(serverId)) continue;
      unsubscribe();
      roomUnsubscribers.delete(serverId);
    }
    sync();
  };
  const stopServers = useServersStore.subscribe(attach);
  attach();
  return () => {
    stopServers();
    for (const unsubscribe of roomUnsubscribers.values()) unsubscribe();
    roomUnsubscribers.clear();
    platform.shell.setBadge(null);
    updateDocumentBadge(0);
  };
}
