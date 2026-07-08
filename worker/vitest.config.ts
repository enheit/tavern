import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// pool-workers 0.18 (vitest 4) API: the pool is a Vite plugin. The
// { singleWorker, isolatedStorage } object the plan mandates lives inside
// cloudflareTest(...) (formerly test.poolOptions.workers). isolatedStorage:false
// + singleWorker are required for the WS + Durable Object tests (PLAN §1).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        singleWorker: true,
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      coverage: {
        provider: 'istanbul',
        include: ['src/**/*.ts'],
        reporter: ['text', 'json'],
        // Enforced from S2.1 (PLAN §1 Coverage: worker lines >=85%).
        thresholds: { lines: 85 },
      },
    },
  };
});
