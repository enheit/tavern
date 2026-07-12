import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToken, setToken } from "../src/main/secrets";
import { resetElectronMock, safeStorage, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

let dir: string;

describe("A5 token storage", () => {
  beforeEach(async () => {
    resetElectronMock();
    dir = mkdtempSync(join(tmpdir(), "tavern-secrets-"));
    state.userDataDir = dir;
    // secrets.ts holds module state (in-memory fallback token) — clear it between tests.
    await setToken(null);
    vi.clearAllMocks();
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

  // Keyring-less linux (bare WMs, minimal distros, CI runners): opt into Electron's basic v10
  // fallback in production AND e2e — v0.4.0 gated this on TAVERN_E2E, so Linux users without an
  // OS keyring hit "Encryption is not available." at login and could not use the app.
  it("forces plain-text encryption on keyring-less linux (production and e2e)", async () => {
    const realPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      safeStorage.isEncryptionAvailable.mockReturnValueOnce(false);
      await setToken("prod-token");
      expect(safeStorage.setUsePlainTextEncryption).toHaveBeenCalledWith(true);

      safeStorage.setUsePlainTextEncryption.mockClear();
      vi.stubEnv("TAVERN_E2E", "1");
      safeStorage.isEncryptionAvailable.mockReturnValueOnce(false);
      await setToken("ci-token");
      expect(safeStorage.setUsePlainTextEncryption).toHaveBeenCalledWith(true);
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      vi.unstubAllEnvs();
    }
  });

  it("never opts into plain-text encryption off linux", async () => {
    const realPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      safeStorage.isEncryptionAvailable.mockReturnValueOnce(false);
      await setToken("mac-token");
      expect(safeStorage.setUsePlainTextEncryption).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }
  });

  // Dead-keyring edge (DE detected → kwallet/libsecret backend selected, but the daemon is down):
  // the v10 opt-in only lifts the basic_text backend, so encryptString still throws. Login must
  // survive — the token is held in memory for this process instead of failing the IPC call.
  it("falls back to an in-memory token when encryption throws", async () => {
    safeStorage.encryptString.mockImplementationOnce(() => {
      throw new Error("Error while encrypting the text provided to safeStorage.encryptString.");
    });
    await expect(setToken("session-token")).resolves.toBeUndefined();
    expect(existsSync(join(dir, "secrets.bin"))).toBe(false);
    expect(await getToken()).toBe("session-token");
  });

  it("setToken(null) clears the in-memory fallback token", async () => {
    safeStorage.encryptString.mockImplementationOnce(() => {
      throw new Error("Encryption is not available.");
    });
    await setToken("session-token");
    await setToken(null);
    expect(await getToken()).toBeNull();
  });

  it("a later successful write replaces the in-memory fallback with the encrypted file", async () => {
    safeStorage.encryptString.mockImplementationOnce(() => {
      throw new Error("Encryption is not available.");
    });
    await setToken("memory-token");
    expect(await getToken()).toBe("memory-token");
    await setToken("disk-token");
    expect(readFileSync(join(dir, "secrets.bin")).toString("utf8")).toBe("enc:disk-token");
    expect(await getToken()).toBe("disk-token");
  });
});
