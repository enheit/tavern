#!/usr/bin/env node
// Pinned release script (S12.2): the semver comes from argv — no auto-bump logic. Writes `version`
// into the root + desktop package.json (electron-builder reads desktop's), commits, tags vX.Y.Z and
// pushes with --follow-tags; the tag push triggers .github/workflows/release.yml.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/release.mjs <X.Y.Z>");
  process.exit(1);
}

for (const file of ["package.json", "desktop/package.json"]) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

const git = (...args) => execFileSync("git", args, { stdio: "inherit" });
git("add", "package.json", "desktop/package.json");
git("commit", "-m", `chore(release): v${version}`);
git("tag", `v${version}`);
git("push", "--follow-tags");
