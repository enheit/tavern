import type { ChatMessage } from "@tavern/shared";
import { platform } from "@/platform/types";
import { roomStore } from "@/stores/room";
import { initUnreadBadges } from "./unreadBadges";
import { playUiSound } from "./uiSounds";
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

// Notify only when the message is NOT already visible to the user (window unfocused OR a different
// server is active) AND the relevant per-account toggle is on. `notifyAll` is a SUPERSET — "notify me
// for all messages" includes mentions of me — so a plain message needs `notifyAll`, while a mention
// notifies if EITHER toggle is on. `notifyMentions` is therefore the "even with all-messages off,
// still ping me when I'm named" switch. Own messages never notify. (This supersedes the earlier rule
// where notifyAll was ignored for mentions, which silently dropped @mentions whenever a user had
// all-messages on but mentions off — the one message class they'd most want.)
export function shouldNotify(msg: NotifyMessage, ctx: NotifyContext): boolean {
  if (msg.userId === ctx.myUserId) return false;
  const mentionsMe = msg.mentions.includes(ctx.myUserId);
  const notVisibleHere = !ctx.windowFocused || ctx.activeServerId !== msg.serverId;
  const toggleOn = ctx.settings.notifyAll || (mentionsMe && ctx.settings.notifyMentions);
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
  if (!ctx.windowFocused) playUiSound("notification");
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

function anyNotifyPrefOn(): boolean {
  const s = useSettingsStore.getState();
  return s.notifyAll || s.notifyMentions;
}

// FR-16 permission bootstrap. The notify toggles default ON, so a fresh account never flips them —
// which means the enable-toggle gesture that would request browser permission never fires, and the
// web bridge's `show()` (no-ops unless permission is "granted") would stay silent forever. When a
// notify pref is on but the browser has never been asked ("default"), request permission — twice over:
//   1. Once immediately at init. Chromium/Firefox surface the prompt with no user gesture, covering a
//      user who enters and tabs away without ever clicking. (The web bridge's requestPermission is
//      async, so a Safari-style "needs a gesture" throw becomes a swallowed rejection, not a crash.)
//   2. On each real user gesture thereafter, as the reliable fallback for engines that ignore the
//      gestureless call — and to re-ask if the first prompt was DISMISSED (which leaves state at
//      "default"; a genuine grant/deny ends the loop). The listener stays armed until the browser
//      actually decides, so one accidental dismissal doesn't silence the whole session.
// Desktop reports "granted" (the OS owns its gate) so none of this runs there. Returns a teardown.
function bootstrapWebPermission(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (platform.notifications.permissionState() !== "default") return () => undefined;
  if (!anyNotifyPrefOn()) return () => undefined;

  let inFlight = false;
  let removed = false;
  const events: ("pointerdown" | "keydown")[] = ["pointerdown", "keydown"];
  const remove = (): void => {
    if (removed) return;
    removed = true;
    for (const ev of events) window.removeEventListener(ev, onGesture, true);
  };
  const attempt = (): void => {
    // Stop for good once the browser has actually decided (granted/denied), or the API vanished.
    if (platform.notifications.permissionState() !== "default") {
      remove();
      return;
    }
    // Nothing to ask while a request is pending or both prefs are off (the user may re-enable a
    // pref later via Settings, so stay armed rather than tearing down).
    if (inFlight || !anyNotifyPrefOn()) return;
    inFlight = true;
    void platform.notifications
      .requestPermission()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        // Granted/denied → done; a dismissed prompt is still "default", so keep listening.
        if (platform.notifications.permissionState() !== "default") remove();
      });
  };
  const onGesture = (): void => attempt();
  for (const ev of events) window.addEventListener(ev, onGesture, true);
  attempt(); // best-effort immediate request (no-op-safe when the engine needs a gesture)
  return remove;
}

// Subscribes to `chat.new` on every joined server's socket (and any joined later) and shows a
// notification for messages that pass `shouldNotify`. Returns a teardown that removes every listener.
export function initNotifications(): () => void {
  const stopBadges = initUnreadBadges();
  const stopFocus = initFocusTracking();
  const stopPermission = bootstrapWebPermission();
  const listeners = new Map<string, () => void>();

  const attach = (serverId: string): void => {
    if (listeners.has(serverId)) return;
    // Claim the slot BEFORE connecting: connectRoom's first status write synchronously re-enters this
    // servers-store subscriber, so without the claim the same server would be subscribed twice.
    listeners.set(serverId, () => {});
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
    stopBadges();
    stopFocus();
    stopPermission();
    stopServers();
    stopClick();
    for (const off of listeners.values()) off();
    listeners.clear();
  };
}
