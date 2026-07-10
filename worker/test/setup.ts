import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    // Test-only binding fed by vitest.config.ts (readD1Migrations) — injected via
    // miniflare bindings, so wrangler types (deployed bindings only) can't generate it.
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
