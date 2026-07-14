#!/usr/bin/env node
// Pinned release script (S12.2): the semver comes from argv — no auto-bump logic. Writes `version`
// into the root + desktop package.json (electron-builder reads desktop's), commits, tags vX.Y.Z and
// atomically pushes the branch and annotated tag; the tag push triggers .github/workflows/release.yml.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/release.mjs <X.Y.Z>");
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { stdio: "inherit" });
const gitOut = (...args) => execFileSync("git", args).toString().trim();
const branch = gitOut("branch", "--show-current");
if (branch === "") {
  console.error("release: detached HEAD is not releasable — check out the release branch first");
  process.exit(1);
}

// Preflight BEFORE mutating anything: a pre-existing tag (local or origin) means this version was
// already cut — v0.1.0 exists from the pre-rewrite Tauri build, for example. Pick the next number.
git("fetch", "--tags", "--quiet", "origin");
if (gitOut("tag", "-l", `v${version}`) !== "") {
  console.error(
    `release: tag v${version} already exists (locally or on origin) — pick a new version`,
  );
  process.exit(1);
}

for (const file of ["package.json", "desktop/package.json"]) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

git("add", "package.json", "desktop/package.json");
// A re-run after a half-failed release may find the bump already committed — skip the empty commit.
if (gitOut("status", "--porcelain", "package.json", "desktop/package.json") !== "") {
  git("commit", "-m", `chore(release): v${version}`);
} else {
  console.log(`release: versions already at ${version} — skipping commit`);
}
git("tag", "-a", `v${version}`, "-m", `v${version}`);
git("push", "--atomic", "origin", `HEAD:refs/heads/${branch}`, `refs/tags/v${version}`);
