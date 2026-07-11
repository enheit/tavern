import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenSourceSchema } from "@tavern/shared";
import type { ScreenSource } from "@tavern/shared";
import { registerIpc } from "../src/main/ipc";
import type { IpcServices } from "../src/main/ipc";
import type { FakeInvokeEvent } from "./electron-mock";
import { ipcMainHandlers, resetElectronMock } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

const TRUSTED: FakeInvokeEvent = { senderFrame: { url: "app://tavern/index.html" } };
const FOREIGN: FakeInvokeEvent = { senderFrame: { url: "https://evil.example/x" } };

const SOURCE: ScreenSource = {
  id: "screen:1",
  name: "Screen 1",
  thumbnailDataUrl: "data:image/png;base64,AAA",
};

function makeServices(): IpcServices {
  return {
    secrets: {
      getToken: vi.fn(() => Promise.resolve<string | null>("tok")),
      setToken: vi.fn(() => Promise.resolve()),
    },
    capture: {
      getScreenSources: vi.fn(() => Promise.resolve([SOURCE])),
      selectSource: vi.fn(() => Promise.resolve()),
      loopbackAudioSupported: vi.fn(() => true),
      screenAccessStatus: vi.fn(() => Promise.resolve("denied" as const)),
      openScreenRecordingSettings: vi.fn(() => Promise.resolve()),
    },
    notifications: { show: vi.fn() },
    updates: { restartToUpdate: vi.fn() },
    shell: { setBadge: vi.fn(), focusWindow: vi.fn() },
  };
}

function handler(channel: string): (event: FakeInvokeEvent, ...args: unknown[]) => unknown {
  const fn = ipcMainHandlers.get(channel);
  if (fn === undefined) throw new Error(`no handler registered for ${channel}`);
  return fn;
}

describe("A10/§6.3 IPC bridge", () => {
  let services: IpcServices;

  beforeEach(() => {
    resetElectronMock();
    services = makeServices();
    registerIpc(services);
  });

  it("registers exactly the eleven §6.3 invoke channels", () => {
    expect([...ipcMainHandlers.keys()].toSorted()).toEqual(
      [
        "capture:getScreenSources",
        "capture:loopbackAudioSupported",
        "capture:openScreenRecordingSettings",
        "capture:screenAccessStatus",
        "capture:selectSource",
        "notifications:show",
        "secrets:getToken",
        "secrets:setToken",
        "shell:focusWindow",
        "shell:setBadge",
        "updates:restartToUpdate",
      ].toSorted(),
    );
  });

  it("rejects invoke from a foreign sender frame", async () => {
    await expect(handler("secrets:getToken")(FOREIGN)).rejects.toThrow(/untrusted/);
    expect(services.secrets.getToken).not.toHaveBeenCalled();
  });

  it("rejects a null sender frame", async () => {
    await expect(handler("secrets:getToken")({ senderFrame: null })).rejects.toThrow(/untrusted/);
  });

  it("rejects a payload that fails its zod schema without partially applying", async () => {
    await expect(handler("secrets:setToken")(TRUSTED, 123)).rejects.toThrow();
    expect(services.secrets.setToken).not.toHaveBeenCalled();

    await expect(handler("notifications:show")(TRUSTED, { title: "x" })).rejects.toThrow();
    expect(services.notifications.show).not.toHaveBeenCalled();

    await expect(handler("shell:setBadge")(TRUSTED, "nope")).rejects.toThrow();
    expect(services.shell.setBadge).not.toHaveBeenCalled();
  });

  it("happy path — secrets:getToken returns the token", async () => {
    expect(await handler("secrets:getToken")(TRUSTED)).toBe("tok");
  });

  it("happy path — secrets:setToken parses string|null and forwards it", async () => {
    await handler("secrets:setToken")(TRUSTED, "abc");
    expect(services.secrets.setToken).toHaveBeenCalledWith("abc");
    await handler("secrets:setToken")(TRUSTED, null);
    expect(services.secrets.setToken).toHaveBeenCalledWith(null);
  });

  it("happy path — capture:getScreenSources returns schema-valid sources", async () => {
    const result = await handler("capture:getScreenSources")(TRUSTED);
    expect(ScreenSourceSchema.array().parse(result)).toEqual([SOURCE]);
  });

  it("happy path — capture:selectSource parses string|null and forwards it", async () => {
    await handler("capture:selectSource")(TRUSTED, "screen:1");
    expect(services.capture.selectSource).toHaveBeenCalledWith("screen:1");
    await handler("capture:selectSource")(TRUSTED, null);
    expect(services.capture.selectSource).toHaveBeenCalledWith(null);
  });

  it("happy path — capture:loopbackAudioSupported returns a boolean", async () => {
    expect(await handler("capture:loopbackAudioSupported")(TRUSTED)).toBe(true);
  });

  it("happy path — capture:screenAccessStatus + openScreenRecordingSettings dispatch", async () => {
    expect(await handler("capture:screenAccessStatus")(TRUSTED)).toBe("denied");
    await handler("capture:openScreenRecordingSettings")(TRUSTED);
    expect(services.capture.openScreenRecordingSettings).toHaveBeenCalledTimes(1);
  });

  it("happy path — notifications:show forwards a valid payload", async () => {
    const payload = { title: "t", body: "b", tag: "srv" };
    await handler("notifications:show")(TRUSTED, payload);
    expect(services.notifications.show).toHaveBeenCalledWith(payload);
  });

  it("happy path — updates:restartToUpdate + shell channels dispatch", async () => {
    await handler("updates:restartToUpdate")(TRUSTED);
    expect(services.updates.restartToUpdate).toHaveBeenCalledTimes(1);
    await handler("shell:setBadge")(TRUSTED, 5);
    expect(services.shell.setBadge).toHaveBeenCalledWith(5);
    await handler("shell:focusWindow")(TRUSTED);
    expect(services.shell.focusWindow).toHaveBeenCalledTimes(1);
  });

  it("accepts a sender frame served from TAVERN_RENDERER_URL", async () => {
    vi.stubEnv("TAVERN_RENDERER_URL", "http://localhost:5173");
    const event: FakeInvokeEvent = { senderFrame: { url: "http://localhost:5173/index.html" } };
    expect(await handler("secrets:getToken")(event)).toBe("tok");
    vi.unstubAllEnvs();
  });
});
