import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// 2026 pool-workers style: cloudflareTest() Vite plugin (defineWorkersConfig/poolOptions is obsolete).
// In 0.18.4 both cloudflareTest and readD1Migrations ship from the package root (no /config subpath).
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Production/local dev opts Images into high-fidelity remote mode, but the test suite must be
      // hermetic and credential-free. Disabling all remote bindings makes the Vitest integration use
      // Wrangler's offline Images implementation instead of opening one remote proxy per test file.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      // TEST_MIGRATIONS is applied by test/setup.ts's applyD1Migrations(); empty until S1.2.
      // TAVERN_SFU_MOCK=1 swaps the Realtime client for the fixture-backed mock (S7.1, §10) so the
      // rtc-proxy tests never touch the live SFU — committed here so CI does not depend on .dev.vars.
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations"), TAVERN_SFU_MOCK: "1" },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**"],
      // The ServerRoom DO + its WS-ticket routes are exercised by the dedicated serial WS project
      // (test:ws, vitest.config.ws.ts) which PLAN §10 excludes from the coverage gate — the default
      // project owns ≥80%. They are not reachable from this project's isolated-storage tests (DO
      // WebSockets are unsupported there), so they are excluded here rather than reported near-zero.
      exclude: ["src/do/**", "src/routes/wsTicket.ts"],
      thresholds: { lines: 80 },
    },
  },
});
