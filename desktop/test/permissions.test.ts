import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPermissionAllowed, registerPermissions } from "../src/main/permissions";
import { resetElectronMock, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

describe("§7.3 permission handlers", () => {
  beforeEach(() => {
    resetElectronMock();
  });

  it("allows exactly media + speaker-selection, denies everything else", () => {
    expect(isPermissionAllowed("media")).toBe(true);
    expect(isPermissionAllowed("speaker-selection")).toBe(true);
    for (const denied of ["geolocation", "notifications", "midi", "clipboard-read", "usb", ""]) {
      expect(isPermissionAllowed(denied)).toBe(false);
    }
  });

  it("wires request + check handlers on the default session that honour the allowlist", () => {
    registerPermissions();

    const request = state.permissionRequestHandler;
    const check = state.permissionCheckHandler;
    expect(request).not.toBeNull();
    expect(check).not.toBeNull();
    if (request === null || check === null) return;

    // media must be granted by BOTH handlers (electron#42713 — else enumerateDevices breaks).
    const grant = vi.fn();
    request({}, "media", grant);
    expect(grant).toHaveBeenCalledWith(true);
    expect(check({}, "media")).toBe(true);
    expect(check({}, "speaker-selection")).toBe(true);

    const deny = vi.fn();
    request({}, "geolocation", deny);
    expect(deny).toHaveBeenCalledWith(false);
    expect(check({}, "notifications")).toBe(false);
    expect(check({}, "geolocation")).toBe(false);
  });
});
