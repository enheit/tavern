import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initNotifications } from "@/lib/notifications";
import { playUiSound } from "@/lib/uiSounds";
import { useServersStore } from "@/stores/servers";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { focusStore } from "@/lib/focusState";

vi.mock("@/lib/wsClient", () => ({
  connectRoom: vi.fn(),
}));
vi.mock("@/lib/uiSounds", () => ({
  playUiSound: vi.fn(),
  primeUiSounds: vi.fn(() => () => undefined),
}));

import { connectRoom } from "@/lib/wsClient";

// FR-16 web permission bootstrap. The notify toggles default ON, so a fresh account never flips them
// and the enable-toggle gesture that would request browser permission never fires. initNotifications
// must therefore request permission itself: once immediately (Chromium/Firefox prompt without a
// gesture, covering a user who never clicks), then on each user gesture as the fallback for engines
// that need activation — staying armed until the browser actually decides so a dismissed prompt does
// not silence the session. `platform` resolves to the web bridge here (no window.tavern), so its
// permissionState/requestPermission read the stubbed global Notification below. Servers are empty so
// initNotifications wires nothing on the sockets.

class FakeNotification {
  static permission: NotificationPermission = "default";
  static next: NotificationPermission = "granted";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
    FakeNotification.permission = FakeNotification.next;
    return FakeNotification.next;
  });
  readonly handlers: Array<() => void> = [];
  constructor(
    readonly title: string,
    readonly options: { body: string; tag: string },
  ) {}
  addEventListener(type: string, cb: () => void): void {
    if (type === "click") this.handlers.push(cb);
  }
}

const fakeNotification = FakeNotification as unknown as typeof FakeNotification & {
  permission: NotificationPermission;
  next: NotificationPermission;
  requestPermission: typeof FakeNotification.requestPermission;
};

let teardown: (() => void) | null = null;

// Flush the async requestPermission()→catch→finally chain (real microtasks, no fake timers).
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useServersStore.setState({ servers: [], activeServerId: null });
  useSettingsStore.setState({ notifyAll: true, notifyMentions: true });
  useSessionStore.setState({
    status: "authed",
    profile: { userId: "me", username: "me", displayName: "Me", color: "#aabbcc" },
  });
  fakeNotification.permission = "default";
  fakeNotification.next = "granted";
  fakeNotification.requestPermission.mockClear();
  vi.mocked(playUiSound).mockClear();
  vi.mocked(connectRoom).mockReset();
  vi.stubGlobal("Notification", fakeNotification);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.unstubAllGlobals();
});

function gesture(): void {
  window.dispatchEvent(new Event("pointerdown"));
}

function fakeConnection() {
  const listeners = new Map<string, (msg: unknown) => void>();
  return {
    on: vi.fn((t: string, cb: (msg: unknown) => void) => {
      listeners.set(t, cb);
      return () => listeners.delete(t);
    }),
    emit(msg: { t: string; [key: string]: unknown }): void {
      listeners.get(msg.t)?.(msg);
    },
  };
}

describe("FR-16 initNotifications web permission bootstrap", () => {
  it("requests permission immediately when a pref is on and permission is 'default'", async () => {
    teardown = initNotifications();
    expect(fakeNotification.requestPermission).toHaveBeenCalledOnce(); // no gesture needed
    await flush();
    expect(fakeNotification.permission).toBe("granted");
  });

  it("stops after a granted prompt — later gestures do not re-request", async () => {
    teardown = initNotifications();
    await flush();
    expect(fakeNotification.requestPermission).toHaveBeenCalledOnce();
    gesture();
    gesture();
    await flush();
    expect(fakeNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("re-arms after a DISMISSED prompt (state stays 'default') and re-requests on the next gesture", async () => {
    fakeNotification.next = "default"; // dismissal: prompt closed without a decision
    teardown = initNotifications();
    await flush();
    expect(fakeNotification.requestPermission).toHaveBeenCalledOnce();
    gesture();
    await flush();
    expect(fakeNotification.requestPermission).toHaveBeenCalledTimes(2);
  });

  it("does not request when permission is already granted", async () => {
    fakeNotification.permission = "granted";
    teardown = initNotifications();
    gesture();
    await flush();
    expect(fakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("does not re-prompt when permission was already denied", async () => {
    fakeNotification.permission = "denied";
    teardown = initNotifications();
    gesture();
    await flush();
    expect(fakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("does not request when both notify prefs are off", async () => {
    useSettingsStore.setState({ notifyAll: false, notifyMentions: false });
    teardown = initNotifications();
    gesture();
    await flush();
    expect(fakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("teardown removes the gesture listener", async () => {
    fakeNotification.next = "default"; // keep state 'default' so the listener would otherwise stay armed
    teardown = initNotifications();
    await flush();
    expect(fakeNotification.requestPermission).toHaveBeenCalledOnce();
    teardown();
    teardown = null;
    gesture();
    await flush();
    expect(fakeNotification.requestPermission).toHaveBeenCalledOnce();
  });
});

describe("FR-16 notification sounds", () => {
  it("plays the notification sound only when the app is unfocused", async () => {
    const conn = fakeConnection();
    vi.mocked(connectRoom).mockReturnValue(conn as never);
    useServersStore.setState({
      servers: [
        {
          id: "srv-1",
          nickname: "tavern",
          adminUserId: "other",
          hasPassword: false,
          createdAt: 1,
          joinedAt: 1,
        },
      ],
      activeServerId: "srv-1",
    });
    teardown = initNotifications();
    focusStore.setState({ focused: false });
    conn.emit({
      t: "chat.new",
      message: { id: 1, userId: "other", body: "hello", mentions: [], reactions: [], at: 1 },
    });
    expect(vi.mocked(playUiSound)).toHaveBeenCalledWith("notification");
  });

  it("does not play the notification sound while focused", async () => {
    const conn = fakeConnection();
    vi.mocked(connectRoom).mockReturnValue(conn as never);
    useServersStore.setState({
      servers: [
        {
          id: "srv-1",
          nickname: "tavern",
          adminUserId: "other",
          hasPassword: false,
          createdAt: 1,
          joinedAt: 1,
        },
      ],
      activeServerId: "srv-1",
    });
    teardown = initNotifications();
    focusStore.setState({ focused: true });
    conn.emit({
      t: "chat.new",
      message: { id: 1, userId: "other", body: "hello", mentions: [], reactions: [], at: 1 },
    });
    expect(vi.mocked(playUiSound)).not.toHaveBeenCalled();
  });
});
