import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { TONE_WAV, WORKER_URL } from "./playwright.config";

// S11.1 worker-served parity target (FR-42). Playwright's `webServer` is a top-level option only —
// there is no per-project webServer — so the worker-target run gets its own config instead of a
// fourth project in playwright.config.ts. The single `web-worker` project runs the SAME e2e/web
// suite as the `web` project, but the browser talks to wrangler on 8787 directly: the worker serves
// the BUILT app (assets binding, SPA fallback) and /api same-origin — no Vite in the loop.
//
// The worker runs `--env e2e` (mock SFU + fast alarms via .dev.vars.e2e) exactly like the e2e worker
// in playwright.config.ts, so the suite stays hermetic. `pnpm e2e:worker-target` builds the app
// BEFORE this config starts wrangler (PLAN §14: wrangler must never have the assets dir rebuilt
// under it — the ordering avoids that by construction).

const here = path.dirname(fileURLToPath(import.meta.url));

const fakeMediaArgs = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${TONE_WAV}`,
];

export default defineConfig({
  testDir: here,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [
    {
      name: "web-worker",
      testMatch: "web/**",
      // @realtime needs the real SFU — nightly `web-realtime` territory, never this target.
      grepInvert: /@realtime/,
      use: {
        channel: "chromium",
        baseURL: WORKER_URL,
        permissions: ["microphone", "camera"],
        launchOptions: { args: fakeMediaArgs },
      },
    },
  ],
  webServer: {
    command: "pnpm -F @tavern/worker exec wrangler dev --env e2e --port 8787",
    url: `${WORKER_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
