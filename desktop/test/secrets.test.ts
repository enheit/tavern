import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToken, setToken } from "../src/main/secrets";
import { resetElectronMock, safeStorage, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

let dir: string;

describe("A5 token storage", () => {
  beforeEach(() => {
    resetElectronMock();
    dir = mkdtempSync(join(tmpdir(), "tavern-secrets-"));
    state.userDataDir = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no secrets file exists", async () => {
    expect(await getToken()).toBeNull();
  });

  it("round-trips a token through safeStorage encryption", async () => {
    await setToken("session-token-123");
    expect(existsSync(join(dir, "secrets.bin"))).toBe(true);
    expect(await getToken()).toBe("session-token-123");
  });

  it("returns null (never throws) on a corrupt secrets file", async () => {
    writeFileSync(join(dir, "secrets.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    expect(await getToken()).toBeNull();
  });

  it("setToken(null) deletes the file", async () => {
    await setToken("to-be-removed");
    expect(existsSync(join(dir, "secrets.bin"))).toBe(true);
    await setToken(null);
    expect(existsSync(join(dir, "secrets.bin"))).toBe(false);
    expect(await getToken()).toBeNull();
  });

  it("setToken(null) on an already-absent file is a no-op", async () => {
    await expect(setToken(null)).resolves.toBeUndefined();
    expect(existsSync(join(dir, "secrets.bin"))).toBe(false);
  });

  it("persists the encrypted (not plaintext) bytes", async () => {
    await setToken("plain-value");
    const raw = readFileSync(join(dir, "secrets.bin")).toString("utf8");
    expect(raw).toBe("enc:plain-value");
  });

  // S12.4 keyring-less CI seam: e2e + linux + no OS password manager → opt into Electron's basic
  // in-memory key (the only supported fallback); production (no TAVERN_E2E) must NOT opt in.
  it("forces plain-text encryption only under e2e on keyring-less linux", async () => {
    const realPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      vi.stubEnv("TAVERN_E2E", "1");
      safeStorage.isEncryptionAvailable.mockReturnValueOnce(false);
      await setToken("ci-token");
      expect(safeStorage.setUsePlainTextEncryption).toHaveBeenCalledWith(true);

      safeStorage.setUsePlainTextEncryption.mockClear();
      vi.unstubAllEnvs();
      safeStorage.isEncryptionAvailable.mockReturnValueOnce(false);
      await setToken("prod-token");
      expect(safeStorage.setUsePlainTextEncryption).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      vi.unstubAllEnvs();
    }
  });
});
