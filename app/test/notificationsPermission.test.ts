import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initNotifications } from "@/lib/notifications";
import { useServersStore } from "@/stores/servers";
import { useSettingsStore } from "@/stores/settings";

// FR-16 web permission bootstrap. The notify toggles default ON, so a fresh account never flips them
// and the enable-toggle gesture that would request browser permission never fires. initNotifications
// must therefore request permission itself: once immediately (Chromium/Firefox prompt without a
// gesture, covering a user who never clicks), then on each user gesture as the fallback for engines
// that need activation — staying armed until the browser actually decides so a dismissed prompt does
// not silence the session. `platform` resolves to the web bridge here (no window.tavern), so its
// permissionState/requestPermission read the stubbed global Notification below. Servers are empty so
// initNotifications wires nothing on the sockets.

const fakeNotification = {
  permission: "default" as NotificationPermission,
  // What a resolved prompt yields; set to "default" to simulate a DISMISSED (not denied) prompt.
  next: "granted" as NotificationPermission,
  requestPermission: vi.fn(async (): Promise<NotificationPermission> => {
    fakeNotification.permission = fakeNotification.next;
    return fakeNotification.next;
  }),
};

let teardown: (() => void) | null = null;

// Flush the async requestPermission()→catch→finally chain (real microtasks, no fake timers).
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useServersStore.setState({ servers: [], activeServerId: null });
  useSettingsStore.setState({ notifyAll: true, notifyMentions: true });
  fakeNotification.permission = "default";
  fakeNotification.next = "granted";
  fakeNotification.requestPermission.mockClear();
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
