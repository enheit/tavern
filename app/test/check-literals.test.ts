import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(dir, "..", "..");
const script = resolve(repoRoot, "scripts/check-i18n-literals.mjs");

function runOn(fixture: string): number {
  const result = spawnSync(process.execPath, [script, resolve(dir, "fixtures", fixture)], {
    encoding: "utf8",
  });
  return result.status ?? 1;
}

describe("§9.6 literal gate self-test", () => {
  it("flags a fixture with hardcoded copy (exit 1)", () => {
    expect(runOn("literal-violation.tsx")).toBe(1);
  });

  it("passes a fixture with only i18n-routed copy (exit 0)", () => {
    expect(runOn("literal-clean.tsx")).toBe(0);
  });
});
