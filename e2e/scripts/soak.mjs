#!/usr/bin/env node
/* oxlint-disable no-await-in-loop -- the soak is deliberately sequential: ordered voice joins and
   paced sampling are the load model, not an accident */
/* oxlint-disable no-underscore-dangle -- reads the pinned §10 e2e hook global window.__tavernTestRtc */
// S12.3 10-client soak (§8 / PLAN §10): register N users via API, join one server, all join voice in
// headless Chromium (branded `channel:'chromium'` — the headless shell has no media capture stack),
// clients 1+2 start fake screen shares, every client watches both, hold for the duration sampling
// connection state, then report. Pass criteria (pinned): wsDisconnects === 0, errorCount === 0,
// statsLatencyMsFinal < 500 ms.
//
//   node e2e/scripts/soak.mjs --clients 10 --minutes 10 [--base http://localhost:8787] [--realtime]
//
// Unless --base is already reachable (GET /api/health → 200), the script spawns the worker itself:
// mock variant `wrangler dev --env e2e` on 8787 (TAVERN_SFU_MOCK=1 + TAVERN_TEST=1 via .dev.vars.e2e);
// --realtime spawns the DEFAULT env on 8788 (real .dev.vars → real Cloudflare Realtime SFU + TURN —
// the nightly soak job writes those from repo secrets). Pages load the worker-served app directly.
// Lives under e2e/ because @playwright/test (which re-exports the library API) is this workspace
// package's dependency (§3 lists no root playwright).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, request } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const TONE_WAV = path.join(here, "..", "fixtures", "tone-440hz-10s.wav");

// ---- args -----------------------------------------------------------------------------------------
function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const realtime = process.argv.includes("--realtime");
const clientCount = Number(argValue("clients", "10"));
const minutes = Number(argValue("minutes", "10"));
const base = argValue("base", realtime ? "http://localhost:8788" : "http://localhost:8787");
if (!Number.isFinite(clientCount) || !Number.isFinite(minutes)) {
  console.error(
    "usage: node e2e/scripts/soak.mjs --clients 10 --minutes 10 [--base URL] [--realtime]",
  );
  process.exit(1);
}

const log = (msg) => console.log(`[soak ${new Date().toISOString()}] ${msg}`);

// ---- worker lifecycle -------------------------------------------------------------------------------
async function healthy() {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

let workerProc = null;
async function ensureWorker() {
  if (await healthy()) {
    log(`reusing reachable worker at ${base}`);
    return;
  }
  const port = new URL(base).port || "8787";
  const args = ["-F", "@tavern/worker", "exec", "wrangler", "dev"];
  if (!realtime) args.push("--env", "e2e");
  args.push("--port", port);
  log(`spawning: pnpm ${args.join(" ")}`);
  workerProc = spawn("pnpm", args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  workerProc.stderr.on("data", (d) => process.stderr.write(`[wrangler] ${d}`));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`worker at ${base} did not become healthy within 120s`);
}
function stopWorker() {
  if (workerProc !== null && workerProc.pid !== undefined) {
    try {
      process.kill(-workerProc.pid, "SIGTERM"); // negative pid → whole wrangler/workerd group
    } catch {
      /* already gone */
    }
  }
}
process.on("SIGINT", () => {
  stopWorker();
  process.exit(130);
});

// ---- API seeding ------------------------------------------------------------------------------------
const hex = (n) => randomBytes(n).toString("hex");

async function registerUser(prefix) {
  const username = `soak_${prefix}_${hex(3)}`;
  const password = `pw-${hex(4)}`;
  const ctx = await request.newContext({ baseURL: base });
  const res = await ctx.post("/api/auth-wrap/register", {
    data: { username, password, repeatPassword: password },
  });
  if (!res.ok()) throw new Error(`register ${username}: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { username, userId: body.user.id, request: ctx };
}

async function waitFor(page, selector, timeout = 30_000) {
  await page.waitForSelector(selector, { timeout, state: "visible" });
}

// ---- main -------------------------------------------------------------------------------------------
const report = {
  clients: clientCount,
  durationMs: 0,
  wsDisconnects: 0,
  reconnects: 0,
  errorCount: 0,
  errors: [],
  statsLatencyMsFinal: -1,
};

// Console/page errors that are environment noise, not product failures:
// - avatar-less users 404 on /api/media/avatars/<uuid>.webp (known prod observation, S11.1);
// - 403 on /api/rtc/:id/tracks — voice.state announces a joiner BEFORE their REST publish registers
//   the mic (§7.1; App-A has no mic-registration frame), so the FIRST mic pull can be pull_denied;
//   the client retries until it lands (S12.3 voiceController fix). Chrome logs every failed HTTP
//   response to the console — the entry itself is not a failure. A pull that NEVER recovers still
//   fails the soak: the unhandled rejection surfaces as a pageerror and watches never connect.
// - 503 on /api/rtc/:id/tracks — LOCAL wrangler dev under the 10-client join burst answers sporadic
//   503s before the request reaches Worker code (S12.4 nightly ×2: worker code emits no 503 anywhere;
//   an upstream-SFU failure maps to the enveloped 502 since the bounded-retry change, so an observed
//   503 is provably the dev runtime). Same recovery story + backstop as the 403 line above.
const NOISE = [
  /\/api\/media\/avatars\//,
  /403.*\/api\/rtc\/.+\/tracks/,
  /503.*\/api\/rtc\/.+\/tracks/,
];
function recordError(source, text) {
  if (NOISE.some((re) => re.test(text))) return;
  report.errorCount += 1;
  if (report.errors.length < 50) report.errors.push(`[${source}] ${text}`);
}

async function main() {
  await ensureWorker();

  log(`registering ${clientCount} users`);
  const users = [];
  for (let i = 0; i < clientCount; i += 1) users.push(await registerUser(String(i)));
  const [admin, ...rest] = users;
  const nickname = `soak-${hex(4)}`;
  const password = `pw-${hex(4)}`;
  // Server creation requires a one-time code (FR-08 hardening) — mint one via the TAVERN_TEST-only
  // seed route (present on the soak worker: its .dev.vars sets TAVERN_TEST=1).
  const seeded = await admin.request.post("/api/__test/seed-code");
  if (!seeded.ok()) throw new Error(`seed-code: ${seeded.status()} ${await seeded.text()}`);
  const { code } = await seeded.json();
  const created = await admin.request.post("/api/servers", { data: { nickname, password, code } });
  if (!created.ok()) throw new Error(`createServer: ${created.status()} ${await created.text()}`);
  const server = await created.json();
  for (const user of rest) {
    const joined = await user.request.post("/api/servers/join", { data: { nickname, password } });
    if (!joined.ok()) throw new Error(`join ${user.username}: ${joined.status()}`);
  }
  log(`server ${server.id} (${nickname}) seeded with ${users.length} members`);

  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${TONE_WAV}`,
    ],
  });

  const clients = [];
  for (const user of users) {
    const context = await browser.newContext({
      baseURL: base,
      storageState: await user.request.storageState(),
      permissions: ["microphone", "camera"],
    });
    const page = await context.newPage();
    page.on("pageerror", (err) => recordError(`pageerror:${user.username}`, String(err)));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      // Network-failure console entries carry the URL in location, not text — include it so the
      // avatar-404 noise filter can see it.
      const url = msg.location().url ?? "";
      recordError(`console:${user.username}`, `${msg.text()} ${url}`.trim());
    });
    clients.push({ user, context, page, lastDot: "connecting" });
  }

  log("booting all clients onto the server room");
  await Promise.all(
    clients.map(async (c) => {
      await c.page.goto(`${base}/?e2e=1`);
      await waitFor(c.page, '[data-testid="app-shell"]');
      // chat.send/voice.join while the WS is still connecting is dropped by design — gate on open.
      await waitFor(c.page, '[data-testid="connection-dot"][data-status="open"]');
      c.lastDot = "open";
    }),
  );

  log("all clients joining voice");
  for (const c of clients) {
    await c.page.click('[data-testid="channel-voice"]');
    await waitFor(c.page, `[data-testid="voice-chip-${c.user.userId}"]`);
    // Fully wired (publish + voice pull connected) before any share/watch — a premature watch's
    // REST pull races the grant and 403s (same gate as the e2e suites).
    await c.page.waitForFunction(
      () =>
        window.__tavernTestRtc?.publishState === "connected" &&
        window.__tavernTestRtc?.pullStates.voice === "connected",
      undefined,
      { timeout: 30_000 },
    );
  }

  log("clients 1 and 2 starting fake screen shares");
  const sharers = clients.slice(0, 2);
  const tracks = [];
  for (const c of sharers) {
    await c.page.click('[data-testid="controls-screen"]');
    const track = `screen:${c.user.userId}:1`;
    await waitFor(c.page, `[data-testid="stream-tile-${track}"]`);
    tracks.push(track);
  }

  log(`every client watching both shares (${tracks.join(", ")})`);
  for (const c of clients) {
    for (const track of tracks) {
      if (track.startsWith(`screen:${c.user.userId}:`)) continue; // own share has no watch button
      await waitFor(c.page, `[data-testid="stream-watch-${track}"]`);
      await c.page.click(`[data-testid="stream-watch-${track}"]`);
      await c.page.waitForFunction(
        (tn) => window.__tavernTestRtc?.pullStates[tn] === "connected",
        track,
        { timeout: 30_000 },
      );
    }
  }

  const statsPing = async () => {
    const t0 = Date.now();
    const res = await admin.request.get(`/api/servers/${server.id}/stats`);
    const latency = Date.now() - t0;
    if (!res.ok()) recordError("stats", `GET stats → ${res.status()}`);
    return latency;
  };

  log(`holding for ${minutes} minute(s)`);
  const start = Date.now();
  const holdMs = minutes * 60_000;
  let lastStatsAt = 0;
  while (Date.now() - start < holdMs) {
    await new Promise((r) => setTimeout(r, 2000));
    // connection sampling: open→non-open = disconnect, non-open→open = reconnect.
    for (const c of clients) {
      const dot = await c.page
        .getAttribute('[data-testid="connection-dot"]', "data-status")
        .catch(() => null);
      if (dot === null) continue;
      if (c.lastDot === "open" && dot !== "open") {
        report.wsDisconnects += 1;
        log(`DISCONNECT: ${c.user.username} dot=${dot}`);
      }
      if (c.lastDot !== "open" && dot === "open") report.reconnects += 1;
      c.lastDot = dot;
    }
    if (Date.now() - lastStatsAt >= 30_000) {
      lastStatsAt = Date.now();
      const latency = await statsPing();
      log(`stats ping ${latency}ms · elapsed ${Math.round((Date.now() - start) / 1000)}s`);
    }
  }
  report.durationMs = Date.now() - start;
  report.statsLatencyMsFinal = await statsPing();

  await Promise.all(clients.map((c) => c.context.close()));
  await browser.close();
  for (const user of users) await user.request.dispose();
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  recordError("harness", String(err));
  console.error(err);
} finally {
  stopWorker();
}

const reportPath = path.join(repoRoot, "soak-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.table([
  {
    clients: report.clients,
    durationMs: report.durationMs,
    wsDisconnects: report.wsDisconnects,
    reconnects: report.reconnects,
    errorCount: report.errorCount,
    statsLatencyMsFinal: report.statsLatencyMsFinal,
  },
]);
if (report.errors.length > 0) console.log("errors:", report.errors);

const pass =
  !failed &&
  report.wsDisconnects === 0 &&
  report.errorCount === 0 &&
  report.statsLatencyMsFinal >= 0 &&
  report.statsLatencyMsFinal < 500;
log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
