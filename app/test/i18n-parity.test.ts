import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { m } from "@/paraglide/messages.js";
import { useSettingsStore } from "@/stores/settings";

const dir = dirname(fileURLToPath(import.meta.url));

function readMessages(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(resolve(dir, "..", "messages", `${locale}.json`), "utf8"));
}

const en = readMessages("en");
const uk = readMessages("uk");
const enKeys = Object.keys(en).filter((key) => !key.startsWith("$"));
const ukKeys = Object.keys(uk).filter((key) => !key.startsWith("$"));
const compiled: Record<string, unknown> = { ...m };

describe("FR-07 locale parity", () => {
  it("en and uk have identical key sets (both directions)", () => {
    expect(new Set(enKeys)).toEqual(new Set(ukKeys));
    for (const key of enKeys) expect(ukKeys).toContain(key);
    for (const key of ukKeys) expect(enKeys).toContain(key);
  });

  it("every message key is flat snake_case (§9.6)", () => {
    for (const key of [...enKeys, ...ukKeys]) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("every message key is a function on the compiled m object", () => {
    for (const key of enKeys) expect(typeof compiled[key]).toBe("function");
  });

  it("setLocale switches the active locale and bumps localeVersion", () => {
    const before = useSettingsStore.getState().localeVersion;
    useSettingsStore.getState().setLocale("uk");
    expect(useSettingsStore.getState().locale).toBe("uk");
    expect(useSettingsStore.getState().localeVersion).toBe(before + 1);

    useSettingsStore.getState().setLocale("en");
    expect(useSettingsStore.getState().locale).toBe("en");
    expect(useSettingsStore.getState().localeVersion).toBe(before + 2);
  });
});
