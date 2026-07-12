import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

// Bearer token (A5) at rest: safeStorage-encrypted bytes in <userData>/secrets.bin.
function secretsPath(): string {
  return join(app.getPath("userData"), "secrets.bin");
}

// Keyring-less Linux (bare WMs like i3/sway, headless boxes, CI runners) exposes no OS password
// manager, so safeStorage.encryptString throws "Encryption is not available." — and the
// --password-store=basic switch alone does NOT lift that (proven twice on ubuntu-latest).
// Electron's sanctioned fallback is setUsePlainTextEncryption: derive the key from Chromium's
// fixed v10 password instead of a keyring — the same scheme Chrome itself uses on such systems.
// Tokens-at-rest degrade to obfuscation there, but login works; v0.4.0 gated this behind the e2e
// harness (S12.4) and production keyring-less Linux could not sign in at all.
let warnedKeyringless = false;
function enableKeyringlessFallback(): void {
  if (process.platform !== "linux" || safeStorage.isEncryptionAvailable()) return;
  safeStorage.setUsePlainTextEncryption(true);
  if (!warnedKeyringless) {
    warnedKeyringless = true;
    console.warn(
      "tavern: no OS keyring available — session token stored with Chromium basic obfuscation",
    );
  }
}

// Last resort: a desktop environment was detected (backend kwallet/gnome_libsecret) but its
// daemon is dead — the v10 opt-in only applies to the basic_text backend, so encryptString still
// throws. Hold the token in memory: login works, it just does not survive an app restart.
let memoryToken: string | null = null;

export async function getToken(): Promise<string | null> {
  enableKeyringlessFallback();
  if (memoryToken !== null) return memoryToken;
  const path = secretsPath();
  if (!existsSync(path)) return null;
  try {
    return safeStorage.decryptString(readFileSync(path));
  } catch {
    // Corrupt / undecryptable file → treat as absent. Never surface the error to the renderer.
    return null;
  }
}

export async function setToken(token: string | null): Promise<void> {
  enableKeyringlessFallback();
  const path = secretsPath();
  if (token === null) {
    memoryToken = null;
    rmSync(path, { force: true });
    return;
  }
  try {
    writeFileSync(path, safeStorage.encryptString(token));
    memoryToken = null;
  } catch (err) {
    memoryToken = token;
    console.warn("tavern: OS keyring unusable — session token held in memory for this run", err);
  }
}
