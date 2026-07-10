import type { ChatMessage } from "@tavern/shared";
import { platform } from "@/platform/types";
import { roomStore } from "@/stores/room";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { focusStore, initFocusTracking } from "./focusState";
import { connectRoom } from "./wsClient";

// FR-16 system notifications. The decision rule, payload shape, and click target are all pinned here;
// the platform bridge (web Notification / desktop main-process Notification) does the actual display.

export type NotifyContext = {
  windowFocused: boolean;
  activeServerId: string | null;
  settings: { notifyAll: boolean; notifyMentions: boolean };
  myUserId: string;
};

type NotifyMessage = { serverId: string; userId: string; mentions: string[] };

// UI truncation length for the notification body — a display concern, NOT a domain limit, so it is a
// module-local const exempt from App-B's single-source rule (§9.3 UPPER_SNAKE-in-limits.ts only).
const NOTIFY_BODY_MAX = 120;

export function truncateBody(body: string): string {
  return body.length > NOTIFY_BODY_MAX ? `${body.slice(0, NOTIFY_BODY_MAX)}…` : body;
}

// Pinned truth: notify only when the message is NOT already visible to the user (window unfocused OR a
// different server is active) AND the relevant per-account toggle is on. For a message that mentions
// the user ONLY `notifyMentions` decides (`notifyAll` is ignored for mentions). Own messages never
// notify.
export function shouldNotify(msg: NotifyMessage, ctx: NotifyContext): boolean {
  if (msg.userId === ctx.myUserId) return false;
  const mentionsMe = msg.mentions.includes(ctx.myUserId);
  const notVisibleHere = !ctx.windowFocused || ctx.activeServerId !== msg.serverId;
  const toggleOn = mentionsMe ? ctx.settings.notifyMentions : ctx.settings.notifyAll;
  return notVisibleHere && toggleOn;
}

function currentContext(): NotifyContext {
  const settings = useSettingsStore.getState();
  return {
    windowFocused: focusStore.getState().focused,
    activeServerId: useServersStore.getState().activeServerId,
    settings: { notifyAll: settings.notifyAll, notifyMentions: settings.notifyMentions },
    myUserId: useSessionStore.getState().profile?.userId ?? "",
  };
}

function handleChatNew(serverId: string, message: ChatMessage): void {
  const ctx = currentContext();
  const msg: NotifyMessage = { serverId, userId: message.userId, mentions: message.mentions };
  if (!shouldNotify(msg, ctx)) return;

  const room = roomStore(serverId).getState();
  const author = room.members.find((mem) => mem.userId === message.userId);
  const displayName = author?.displayName ?? "";
  const serverNickname = room.serverMeta?.nickname ?? "";
  const mentionsMe = message.mentions.includes(ctx.myUserId);
  const body = truncateBody(message.body);
  void platform.notifications.show({
    title: `${displayName} — ${serverNickname}`,
    // A mention notification prefixes the body with '@ ' (pinned).
    body: mentionsMe ? `@ ${body}` : body,
    // `tag` is the serverId — the only value onClick receives, and the click handler routes to it.
    tag: serverId,
  });
}

// Clicking a notification focuses the app and routes to the message's server. react-router runs a hash
// history on desktop (file:// origin) and a browser history on the web, so navigation goes through the
// matching mechanism rather than a full reload.
function focusAndNavigate(tag: string): void {
  platform.shell.focusWindow();
  if (typeof window === "undefined") return;
  const path = `/s/${tag}`;
  if (platform.kind === "desktop") {
    window.location.hash = `#${path}`;
  } else {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

// Subscribes to `chat.new` on every joined server's socket (and any joined later) and shows a
// notification for messages that pass `shouldNotify`. Returns a teardown that removes every listener.
export function initNotifications(): () => void {
  const stopFocus = initFocusTracking();
  const listeners = new Map<string, () => void>();

  const attach = (serverId: string): void => {
    if (listeners.has(serverId)) return;
    const off = connectRoom(serverId).on("chat.new", (frame) => {
      handleChatNew(serverId, frame.message);
    });
    listeners.set(serverId, off);
  };

  for (const server of useServersStore.getState().servers) attach(server.id);
  const stopServers = useServersStore.subscribe((state) => {
    for (const server of state.servers) attach(server.id);
  });

  const stopClick = platform.notifications.onClick(focusAndNavigate);

  return () => {
    stopFocus();
    stopServers();
    stopClick();
    for (const off of listeners.values()) off();
    listeners.clear();
  };
}
