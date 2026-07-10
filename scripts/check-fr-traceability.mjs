// FR-traceability gate: every FR-01..FR-45 must appear in at least one test file's contents.
// Zero dependencies (node:fs / node:path only). Informational until S12.4 runs it with STRICT=1.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["shared", "worker", "app", "desktop", "e2e"];
const SKIP = new Set(["node_modules", "dist", "out", "coverage"]);
const TEST_RE = /\.(test\.tsx?|spec\.ts)$/;

function collect(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, acc);
    else if (TEST_RE.test(entry.name)) acc.push(full);
  }
  return acc;
}

const files = [];
for (const root of ROOTS) collect(root, files);

const covered = new Set();
for (const file of files) {
  for (const match of readFileSync(file, "utf8").matchAll(/FR-\d{2}/g)) {
    covered.add(match[0]);
  }
}

const expected = Array.from({ length: 45 }, (_, i) => `FR-${String(i + 1).padStart(2, "0")}`);
const missing = expected.filter((fr) => !covered.has(fr));
for (const fr of missing) console.log(`MISSING ${fr}`);
console.log(`covered ${expected.length - missing.length}/45`);

if (process.env.STRICT === "1" && missing.length > 0) process.exit(1);
