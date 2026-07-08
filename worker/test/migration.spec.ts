import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Migration 0001 is applied to the shared test DB by test/apply-migrations.ts.
// These assert it took effect. Per the random-fixture rule (test/README.md) we
// never assert table counts or reuse fixed nicknames.
describe('migration 0001', () => {
  it('created the control-plane tables', async () => {
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all<{ name: string }>();
    const names = new Set(rows.results.map((r) => r.name));
    for (const t of [
      'users',
      'sessions',
      'servers',
      'channels',
      'memberships',
      'channel_access',
      'budget_usage',
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });

  it('enforces case-insensitive UNIQUE nickname (COLLATE NOCASE)', async () => {
    const base = 'u' + crypto.randomUUID().replace(/-/g, ''); // lowercase
    const insert = (nick: string) =>
      env.DB.prepare(
        `INSERT INTO users (id, nickname, pw_hash, pw_salt, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), nick, new Uint8Array([1]), new Uint8Array([2]), Date.now())
        .run();

    await insert(base);
    // Same letters, different case → must collide on the NOCASE unique index.
    await expect(insert(base.toUpperCase())).rejects.toThrow(/UNIQUE|constraint/i);
  });
});
