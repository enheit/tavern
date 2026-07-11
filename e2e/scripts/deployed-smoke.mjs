#!/usr/bin/env node
// FR-42 deployed-smoke runner. Server creation needs a one-time creation code (FR-08) and production
// has no test seed route — so this wrapper mints an EPHEMERAL code with the operator's own wrangler
// credentials, hands it to the spec via SMOKE_CREATE_CODE, and cleans it up afterwards:
// the spec burns it on success (the audit row then records the smoke server); if the run dies before
// spending it, the unused row is deleted. No standing codes ever live in production for smoke runs.
//
//   node e2e/scripts/deployed-smoke.mjs --base https://tavern.roman-mahotskyi.workers.dev
//
// Requires wrangler auth able to run `d1 execute tavern-db --remote` (same auth as migrate:remote).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const base = argValue("base", process.env.E2E_BASE_URL);
if (base === undefined || base === "") {
  console.error("usage: node e2e/scripts/deployed-smoke.mjs --base https://<deployed-worker-url>");
  process.exit(1);
}

const log = (msg) => console.log(`[deployed-smoke ${new Date().toISOString()}] ${msg}`);

// Runs a command inheriting stdio; resolves with its exit code (spawn errors reject).
function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

// `wrangler d1 execute` against the REMOTE production DB (runs from worker/ via pnpm -F).
function d1Remote(sql) {
  return run("pnpm", [
    "-F",
    "@tavern/worker",
    "exec",
    "wrangler",
    "d1",
    "execute",
    "tavern-db",
    "--remote",
    "--command",
    sql,
  ]);
}

async function main() {
  const code = randomUUID();
  log("seeding ephemeral creation code into the deployed D1");
  const seeded = await d1Remote(
    `INSERT INTO server_creation_codes (code, created_at) VALUES ('${code}', ${Date.now()})`,
  );
  if (seeded !== 0) {
    console.error("seeding failed — is wrangler authenticated for the tavern account?");
    process.exit(seeded);
  }

  let exitCode = 1;
  try {
    exitCode = await run(
      "pnpm",
      [
        "-F",
        "@tavern/e2e",
        "exec",
        "playwright",
        "test",
        "--project=web",
        "web/deployed-smoke.spec.ts",
      ],
      { E2E_BASE_URL: base, SMOKE_CREATE_CODE: code },
    );
  } finally {
    // Spent → keep the audit row (used_by/used_at/created_server_id). Unspent (failed early run) →
    // remove it so no live code lingers in production.
    log("cleaning up the code if it went unused");
    await d1Remote(`DELETE FROM server_creation_codes WHERE code = '${code}' AND used_at IS NULL`);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
