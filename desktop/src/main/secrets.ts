import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

// Bearer token (A5) at rest: safeStorage-encrypted bytes in <userData>/secrets.bin.
function secretsPath(): string {
  return join(app.getPath("userData"), "secrets.bin");
}

// Headless-CI seam (S12.4): a keyring-less Linux (CI runners, bare WMs) exposes no OS password
// manager, so safeStorage.encryptString throws "Encryption is not available." — and the
// --password-store=basic switch alone does NOT lift that (proven twice on ubuntu-latest).
// Electron's sanctioned fallback is setUsePlainTextEncryption: force the in-memory key, but ONLY
// under the e2e harness — a production Linux without a keyring keeps failing closed rather than
// silently downgrading tokens-at-rest to an obfuscated plaintext.
function forceBasicEncryptionForE2E(): void {
  if (process.env.TAVERN_E2E !== "1" || process.platform !== "linux") return;
  if (!safeStorage.isEncryptionAvailable()) safeStorage.setUsePlainTextEncryption(true);
}

export async function getToken(): Promise<string | null> {
  forceBasicEncryptionForE2E();
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
  forceBasicEncryptionForE2E();
  const path = secretsPath();
  if (token === null) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, safeStorage.encryptString(token));
}
