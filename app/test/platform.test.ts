import { afterEach, describe, expect, it, vi } from "vitest";
import type { TavernIpc } from "@tavern/shared";
import { createElectronPlatform } from "@/platform/electron";
import { createWebPlatform } from "@/platform/web";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("platform/web", () => {
  it("is a web bridge with empty capture, cookie-mode secrets, and no-op updates", async () => {
    const p = createWebPlatform();
    expect(p.kind).toBe("web");
    expect(await p.capture.getScreenSources()).toEqual([]);
    expect(await p.capture.loopbackAudioSupported()).toBe(false);
    expect(await p.secrets.getToken()).toBeNull();
    await p.secrets.setToken("ignored"); // no throw
    await p.capture.selectSource(null); // no throw

    const offUpdate = p.updates.onUpdateReady(() => undefined);
    expect(typeof offUpdate).toBe("function");
    offUpdate();
    p.updates.restartToUpdate(); // no throw
    p.shell.setBadge(3); // no throw (reserved)
  });

  it("shows a Notification and dispatches clicks by tag", async () => {
    const instances: FakeNotification[] = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      readonly handlers: Array<() => void> = [];
      constructor(
        readonly title: string,
        readonly options: { body: string; tag: string },
      ) {
        instances.push(this);
      }
      addEventListener(type: string, cb: () => void): void {
        if (type === "click") this.handlers.push(cb);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);

    const p = createWebPlatform();
    const clicked: string[] = [];
    const off = p.notifications.onClick((tag) => clicked.push(tag));
    await p.notifications.show({ title: "Hi", body: "body", tag: "t1" });

    expect(instances).toHaveLength(1);
    for (const h of instances[0]?.handlers ?? []) h();
    expect(clicked).toEqual(["t1"]);

    off();
    for (const h of instances[0]?.handlers ?? []) h();
    expect(clicked).toEqual(["t1"]); // unsubscribed — no further pushes
  });
});

function makeIpc(): TavernIpc {
  return {
    platform: "darwin",
    isE2E: false,
    secrets: {
      getToken: vi.fn(async () => "tok"),
      setToken: vi.fn(async () => undefined),
    },
    capture: {
      getScreenSources: vi.fn(async () => []),
      selectSource: vi.fn(async () => undefined),
      loopbackAudioSupported: vi.fn(async () => true),
    },
    notifications: {
      show: vi.fn(async () => undefined),
      onClick: vi.fn(),
    },
    updates: {
      onUpdateReady: vi.fn(),
      restartToUpdate: vi.fn(async () => undefined),
    },
    shell: {
      setBadge: vi.fn(async () => undefined),
      focusWindow: vi.fn(async () => undefined),
    },
  };
}

describe("platform/electron", () => {
  it("delegates to window.tavern and validates outbound args", async () => {
    const ipc = makeIpc();
    const p = createElectronPlatform(ipc);
    expect(p.kind).toBe("desktop");

    await p.secrets.setToken("abc");
    expect(ipc.secrets.setToken).toHaveBeenCalledWith("abc");
    await p.capture.selectSource(null);
    expect(ipc.capture.selectSource).toHaveBeenCalledWith(null);
    await p.notifications.show({ title: "t", body: "b", tag: "tag" });
    expect(ipc.notifications.show).toHaveBeenCalledWith({ title: "t", body: "b", tag: "tag" });
    p.shell.setBadge(5);
    expect(ipc.shell.setBadge).toHaveBeenCalledWith(5);
    p.shell.focusWindow();
    expect(ipc.shell.focusWindow).toHaveBeenCalled();
    p.updates.restartToUpdate();
    expect(ipc.updates.restartToUpdate).toHaveBeenCalled();
  });

  it("fans notification-click and update-ready callbacks out with unsubscribe", () => {
    // Holder object defeats TS closure-assignment narrowing to `never`.
    const wired: {
      click: ((tag: string) => void) | null;
      update: (() => void) | null;
    } = { click: null, update: null };
    const ipc = makeIpc();
    ipc.notifications.onClick = vi.fn((cb: (tag: string) => void) => {
      wired.click = cb;
    });
    ipc.updates.onUpdateReady = vi.fn((cb: (info: { version: string }) => void) => {
      wired.update = () => cb({ version: "1.0.0" });
    });
    const p = createElectronPlatform(ipc);

    const clicks: string[] = [];
    const offClick = p.notifications.onClick((tag) => clicks.push(tag));
    wired.click?.("t9");
    expect(clicks).toEqual(["t9"]);
    offClick();
    wired.click?.("t10");
    expect(clicks).toEqual(["t9"]);

    let updates = 0;
    const offUpdate = p.updates.onUpdateReady(() => {
      updates += 1;
    });
    wired.update?.();
    expect(updates).toBe(1);
    offUpdate();
    wired.update?.();
    expect(updates).toBe(1);
  });
});
