import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// 2026 pool-workers style: cloudflareTest() Vite plugin (defineWorkersConfig/poolOptions is obsolete).
// In 0.18.4 both cloudflareTest and readD1Migrations ship from the package root (no /config subpath).
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      // TEST_MIGRATIONS is applied by test/setup.ts's applyD1Migrations(); empty until S1.2.
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**"],
      thresholds: { lines: 80 },
    },
  },
});
