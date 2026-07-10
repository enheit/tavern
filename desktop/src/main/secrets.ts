import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

// Bearer token (A5) at rest: safeStorage-encrypted bytes in <userData>/secrets.bin.
function secretsPath(): string {
  return join(app.getPath("userData"), "secrets.bin");
}

export async function getToken(): Promise<string | null> {
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
  const path = secretsPath();
  if (token === null) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, safeStorage.encryptString(token));
}
