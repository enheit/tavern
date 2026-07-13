import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import { z } from "zod";

const DesktopPreferencesV1Schema = z.object({
  version: z.literal(1),
  closeToTray: z.boolean(),
});

type DesktopPreferencesV1 = z.infer<typeof DesktopPreferencesV1Schema>;

const DEFAULT_PREFERENCES: DesktopPreferencesV1 = { version: 1, closeToTray: true };

let preferences: DesktopPreferencesV1 | null = null;

function preferencesPath(): string {
  return join(app.getPath("userData"), "config", "preferences.v1.json");
}

function readPreferences(): DesktopPreferencesV1 {
  const path = preferencesPath();
  if (!existsSync(path)) return DEFAULT_PREFERENCES;

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = DesktopPreferencesV1Schema.safeParse(parsed);
    if (result.success) return result.data;
    console.warn("desktop preferences are invalid; using defaults", result.error);
  } catch (error) {
    console.warn("desktop preferences could not be read; using defaults", error);
  }
  return DEFAULT_PREFERENCES;
}

function currentPreferences(): DesktopPreferencesV1 {
  if (preferences === null) preferences = readPreferences();
  return preferences;
}

function writePreferences(next: DesktopPreferencesV1): void {
  const path = preferencesPath();
  const tempPath = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tempPath, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch (cleanupError) {
      console.warn("desktop preferences temporary file could not be removed", cleanupError);
    }
    throw error;
  }
}

export function initializePreferences(): void {
  preferences = readPreferences();
}

export function getCloseToTray(): boolean {
  return currentPreferences().closeToTray;
}

export function setCloseToTray(value: boolean): void {
  const next: DesktopPreferencesV1 = { ...currentPreferences(), closeToTray: value };
  writePreferences(next);
  preferences = next;
}
