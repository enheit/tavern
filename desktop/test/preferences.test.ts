import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCloseToTray, initializePreferences, setCloseToTray } from "../src/main/preferences";
import { resetElectronMock, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

describe("desktop preferences", () => {
  let dir: string;

  beforeEach(() => {
    resetElectronMock();
    dir = mkdtempSync(join(tmpdir(), "tavern-preferences-"));
    state.userDataDir = dir;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults close-to-tray to enabled when no file exists", () => {
    initializePreferences();
    expect(getCloseToTray()).toBe(true);
  });

  it("persists the value and reloads it from the versioned file", () => {
    initializePreferences();
    setCloseToTray(false);

    expect(JSON.parse(readFileSync(join(dir, "config", "preferences.v1.json"), "utf8"))).toEqual({
      version: 1,
      closeToTray: false,
    });
    initializePreferences();
    expect(getCloseToTray()).toBe(false);
  });

  it("logs invalid data and falls back to enabled", () => {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "preferences.v1.json"), '{"closeToTray":"no"}');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    initializePreferences();

    expect(getCloseToTray()).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not change the in-memory value when persistence fails", () => {
    writeFileSync(join(dir, "config"), "not a directory");
    initializePreferences();

    expect(() => setCloseToTray(false)).toThrow();
    expect(getCloseToTray()).toBe(true);
  });
});
