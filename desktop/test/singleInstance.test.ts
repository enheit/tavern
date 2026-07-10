import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSingleInstanceLock } from "../src/main/singleInstance";
import { focusMainWindow } from "../src/main/window";
import { app, emitAppEvent, resetElectronMock, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));
vi.mock("../src/main/window", () => ({ focusMainWindow: vi.fn() }));

describe("single-instance lock", () => {
  beforeEach(() => {
    resetElectronMock();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips the lock entirely in E2E mode (two instances launched on purpose)", () => {
    vi.stubEnv("TAVERN_E2E", "1");
    expect(acquireSingleInstanceLock()).toBe(true);
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
  });

  it("acquires the lock and focuses the window on a second-instance event", () => {
    state.singleInstanceLock = true;
    expect(acquireSingleInstanceLock()).toBe(true);
    expect(focusMainWindow).not.toHaveBeenCalled();
    emitAppEvent("second-instance");
    expect(focusMainWindow).toHaveBeenCalledTimes(1);
  });

  it("returns false when another instance holds the lock", () => {
    state.singleInstanceLock = false;
    expect(acquireSingleInstanceLock()).toBe(false);
  });
});
