import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// S11.1 FR-42: the web platform bridge audit tests + the pinned permission UX (enabling a
// notification toggle while permission is 'default' requests it; 'denied' reverts the switch and
// shows S6.2's one-time toast). The REST seam and sonner are mocked; stores + section are real.
vi.mock("@/lib/apiClient", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(async () => ({
      notifyAll: true,
      notifyMentions: true,
      locale: "en",
      theme: "system",
    })),
    del: vi.fn(),
    upload: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { toast } from "sonner";
import { NotificationsSection } from "@/features/settings/NotificationsSection";
import { m } from "@/paraglide/messages.js";
import { useSettingsStore } from "@/stores/settings";
import { createWebPlatform } from "./web";

// The permission-UX path reads only the STATIC Notification surface (permission +
// requestPermission) — never `new Notification` — so a plain object stub suffices.
const fakeNotification = {
  permission: "default" as NotificationPermission,
  requestPermission: vi.fn(async (): Promise<NotificationPermission> => "granted"),
};

beforeEach(() => {
  useSettingsStore.setState({
    theme: "system",
    locale: "en",
    notifyAll: false,
    notifyMentions: false,
  });
  fakeNotification.permission = "default";
  fakeNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", fakeNotification);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FR-42 web platform bridge", () => {
  it("satisfies the PlatformBridge contract shape", () => {
    const p = createWebPlatform();
    expect(p.kind).toBe("web");
    expect(p.os).toBe("web");
    expect(typeof p.isE2E).toBe("boolean");
    expect(typeof p.secrets.getToken).toBe("function");
    expect(typeof p.secrets.setToken).toBe("function");
    expect(typeof p.capture.getScreenSources).toBe("function");
    expect(typeof p.capture.selectSource).toBe("function");
    expect(typeof p.capture.loopbackAudioSupported).toBe("function");
    expect(typeof p.notifications.show).toBe("function");
    expect(typeof p.notifications.onClick).toBe("function");
    expect(typeof p.notifications.requestPermission).toBe("function");
    expect(typeof p.updates.onUpdateReady).toBe("function");
    expect(typeof p.updates.restartToUpdate).toBe("function");
    expect(typeof p.shell.setBadge).toBe("function");
    expect(typeof p.shell.focusWindow).toBe("function");
  });

  it("permissionState mirrors Notification.permission, 'unsupported' when the API is absent", () => {
    const p = createWebPlatform();
    fakeNotification.permission = "default";
    expect(p.notifications.permissionState()).toBe("default");
    fakeNotification.permission = "granted";
    expect(p.notifications.permissionState()).toBe("granted");
    fakeNotification.permission = "denied";
    expect(p.notifications.permissionState()).toBe("denied");
    vi.stubGlobal("Notification", undefined);
    expect(p.notifications.permissionState()).toBe("unsupported");
  });

  it("secrets resolve null", async () => {
    const p = createWebPlatform();
    expect(await p.secrets.getToken()).toBeNull();
    await p.secrets.setToken("ignored"); // no-op, no throw (cookies carry the session)
    expect(await p.secrets.getToken()).toBeNull();
  });

  it("loopbackAudioSupported false", async () => {
    const p = createWebPlatform();
    expect(await p.capture.loopbackAudioSupported()).toBe(false);
    expect(await p.capture.getScreenSources()).toEqual([]);
  });

  it("notification toggle requests permission when default", async () => {
    render(<NotificationsSection />);
    fireEvent.click(screen.getByTestId("settings-notify-all"));
    await waitFor(() => expect(fakeNotification.requestPermission).toHaveBeenCalledOnce());
    // granted → the toggle applies and persists.
    await waitFor(() => expect(useSettingsStore.getState().notifyAll).toBe(true));
  });

  it("denied permission reverts toggle", async () => {
    fakeNotification.requestPermission.mockResolvedValueOnce("denied");
    render(<NotificationsSection />);
    fireEvent.click(screen.getByTestId("settings-notify-mentions"));
    await waitFor(() => expect(fakeNotification.requestPermission).toHaveBeenCalledOnce());
    // denial → the store never flips (the controlled switch stays off) + S6.2's toast key fires.
    expect(useSettingsStore.getState().notifyMentions).toBe(false);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(m.settings_notifications_denied()));
  });

  it("show() constructs a real Notification when granted (no e2e sink) and routes its click", async () => {
    // The e2e sink short-circuits show() before the permission gate + construction, so that path has
    // no e2e coverage — this exercises it directly. No sink is installed in this jsdom env.
    const calls: [string, { body?: string; tag?: string }][] = [];
    class ConstructableNotification {
      static permission: NotificationPermission = "granted";
      clickHandler?: () => void;
      constructor(title: string, opts: { body?: string; tag?: string }) {
        calls.push([title, opts]);
        instances.push(this);
      }
      addEventListener(type: string, cb: () => void): void {
        if (type === "click") this.clickHandler = cb;
      }
    }
    const instances: ConstructableNotification[] = [];
    vi.stubGlobal("Notification", ConstructableNotification);

    const p = createWebPlatform();
    const clicked = vi.fn();
    p.notifications.onClick(clicked);
    await p.notifications.show({ title: "Alice — tavern", body: "hello", tag: "srv-9" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["Alice — tavern", { body: "hello", tag: "srv-9" }]);
    instances[0]?.clickHandler?.(); // simulate the OS click on the notification
    expect(clicked).toHaveBeenCalledWith("srv-9");
  });

  it("show() no-ops (constructs nothing) when permission is not granted", async () => {
    const calls: unknown[] = [];
    class ConstructableNotification {
      static permission: NotificationPermission = "default";
      constructor(...args: unknown[]) {
        calls.push(args);
      }
      addEventListener(): void {
        // unused
      }
    }
    vi.stubGlobal("Notification", ConstructableNotification);
    const p = createWebPlatform();
    await p.notifications.show({ title: "T", body: "B", tag: "srv-1" });
    expect(calls).toHaveLength(0);
  });

  it("update surface is inert on web (the S12.2 update pill has nothing to render)", () => {
    const p = createWebPlatform();
    const cb = vi.fn();
    const off = p.updates.onUpdateReady(cb);
    p.updates.restartToUpdate(); // no-op
    expect(cb).not.toHaveBeenCalled(); // onUpdateReady never fires on web
    off();
  });
});
