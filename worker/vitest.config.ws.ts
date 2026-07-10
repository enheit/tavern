import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Dedicated project for the ServerRoom DO WebSocket tests. Per-file storage isolation does not
// support DO WebSockets (official known issue), so `test:ws` runs it with `--max-workers=1
// --no-isolate` (shared storage, serial). PLAN §10 excludes this project from the coverage gate —
// the default project (vitest.config.ts) owns ≥80%. Same cloudflareTest plugin + wrangler config as
// S1.1's; TEST_MIGRATIONS is fed to test/setup.ts's applyD1Migrations() for the through-Worker flow.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
    })),
  ],
  test: {
    include: ["test/ws/**/*.spec.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
