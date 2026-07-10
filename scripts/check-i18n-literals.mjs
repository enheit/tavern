// §9.6 i18n literal gate: user-visible string literals in JSX are forbidden — all copy goes
// through Paraglide (`m.*()`). Parses `app/src/**/*.tsx` (excluding `components/ui/`, which is
// generated) with oxc-parser and fails on:
//   - JSXText containing letters, and
//   - string literals passed to user-facing props: title | label | placeholder | alt | aria-*
// Lines listed in `scripts/i18n-allowlist.txt` (as `<repo-relative-path>:<line>`) are exempt.
//
// Usage:
//   node scripts/check-i18n-literals.mjs            # scans app/src (the CI gate)
//   node scripts/check-i18n-literals.mjs <path...>  # scans the given files/dirs (self-test)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(scriptPath, "..", "..");

const FLAGGED_PROPS = new Set(["title", "label", "placeholder", "alt"]);
const LETTER = /\p{L}/u;

function isExcluded(path) {
  return path.includes(`${sep}components${sep}ui${sep}`);
}

function collectTsx(target, acc) {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return acc;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      collectTsx(join(target, entry.name), acc);
    }
  } else if (target.endsWith(".tsx") && !isExcluded(target)) {
    acc.push(target);
  }
  return acc;
}

function loadAllowlist() {
  const set = new Set();
  try {
    const raw = readFileSync(resolve(repoRoot, "scripts/i18n-allowlist.txt"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) set.add(trimmed);
    }
  } catch {
    // No allowlist file → nothing exempt.
  }
  return set;
}

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type") continue;
    const value = node[key];
    if (value && typeof value === "object") walk(value, visit);
  }
}

function attrName(name) {
  if (!name) return "";
  if (name.type === "JSXNamespacedName") return `${name.namespace.name}:${name.name.name}`;
  return name.name ?? "";
}

function isFlaggedProp(name) {
  return FLAGGED_PROPS.has(name) || name.startsWith("aria-");
}

function stringLiteralWithLetters(node) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string" && LETTER.test(node.value)) {
    return node;
  }
  if (node.type === "JSXExpressionContainer") return stringLiteralWithLetters(node.expression);
  return undefined;
}

function checkFile(file, allowlist, violations) {
  const source = readFileSync(file, "utf8");
  const parsed = parseSync(file, source, { sourceType: "module" });
  const rel = relative(repoRoot, file);
  const starts = lineStarts(source);

  for (const error of parsed.errors) {
    violations.push(`${rel}: parse error: ${error.message}`);
  }

  walk(parsed.program, (node) => {
    if (node.type === "JSXText" && LETTER.test(node.value)) {
      const line = lineAt(starts, node.start);
      if (!allowlist.has(`${rel}:${line}`)) {
        violations.push(`${rel}:${line} JSX text literal: ${JSON.stringify(node.value.trim())}`);
      }
      return;
    }
    if (node.type === "JSXAttribute" && isFlaggedProp(attrName(node.name))) {
      const literal = stringLiteralWithLetters(node.value);
      if (literal) {
        const line = lineAt(starts, literal.start);
        if (!allowlist.has(`${rel}:${line}`)) {
          violations.push(
            `${rel}:${line} literal in <${attrName(node.name)}>: ${JSON.stringify(literal.value)}`,
          );
        }
      }
    }
  });
}

function main() {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args.map((a) => resolve(a)) : [resolve(repoRoot, "app/src")];
  const files = [];
  for (const target of targets) collectTsx(target, files);

  const allowlist = loadAllowlist();
  const violations = [];
  for (const file of files) checkFile(file, allowlist, violations);

  if (violations.length > 0) {
    console.error(`i18n literal gate: ${violations.length} violation(s) (§9.6):`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(`i18n literal gate: clean (${files.length} file(s) scanned).`);
}

main();
