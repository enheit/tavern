import { applyD1Migrations, env } from 'cloudflare:test';

// Applies D1 migrations to the shared test database before the suite runs.
// TEST_MIGRATIONS is empty until S2.1 adds migration 0001; the plumbing is
// wired now so later steps just drop SQL into worker/migrations/.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
