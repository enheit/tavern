import { Hono } from 'hono';
import type { Env } from '../index';
import * as pw from '../lib/crypto'; // namespace import so verifyPassword is spy-able (S2.3 DoD)
import {
  createChannelSchema,
  createServerSchema,
  joinServerSchema,
  unlockSchema,
} from '../lib/schemas';
import { type AuthVars, bearerAuth } from '../middleware/auth';

// Servers / channels / membership / unlock (PLAN §1 HTTP contract). Every route
// is bearer-authed.
const servers = new Hono<{ Bindings: Env; Variables: AuthVars }>();
servers.use('*', bearerAuth);

// Anti-enumeration: a join to a nonexistent server runs one verify against these
// dummies so it is indistinguishable (call-count + response) from wrong_password.
const DUMMY_SALT = new Uint8Array(16);
const DUMMY_HASH = new Uint8Array(32);

servers.post('/servers', async (c) => {
  const parsed = createServerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: 'invalid' }, 400);
  const { name, password } = parsed.data;

  const id = crypto.randomUUID();
  const now = Date.now();
  let pwHash: Uint8Array | null = null;
  let pwSalt: Uint8Array | null = null;
  if (password) {
    const h = await pw.hashPassword(password);
    pwHash = h.hash;
    pwSalt = h.salt;
  }

  await c.env.DB.prepare(
    `INSERT INTO servers (id, name, owner_id, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, name, c.get('userId'), pwHash, pwSalt, now)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO memberships (user_id, server_id, role, joined_at) VALUES (?, ?, 'owner', ?)`,
  )
    .bind(c.get('userId'), id, now)
    .run();

  return c.json({ id, name }, 201);
});

servers.post('/servers/join', async (c) => {
  const parsed = joinServerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: 'invalid' }, 400);
  const { serverId, password } = parsed.data;
  const userId = c.get('userId');

  const server = await c.env.DB.prepare(
    'SELECT id, name, pw_hash, pw_salt FROM servers WHERE id = ?',
  )
    .bind(serverId)
    .first<{ id: string; name: string; pw_hash: ArrayBuffer | null; pw_salt: ArrayBuffer | null }>();

  // Nonexistent → identical to wrong_password (one verify, same response). §1 DoD.
  if (!server) {
    await pw.verifyPassword(password ?? '', DUMMY_SALT, DUMMY_HASH);
    return c.json({ code: 'wrong_password' }, 403);
  }

  // Already a member → idempotent 200, no password re-check.
  const member = await c.env.DB.prepare(
    'SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?',
  )
    .bind(userId, serverId)
    .first();
  if (member) return c.json({ id: server.id, name: server.name });

  if (server.pw_hash && server.pw_salt) {
    const ok = await pw.verifyPassword(
      password ?? '',
      new Uint8Array(server.pw_salt),
      new Uint8Array(server.pw_hash),
    );
    if (!ok) return c.json({ code: 'wrong_password' }, 403);
  }

  await c.env.DB.prepare(
    `INSERT INTO memberships (user_id, server_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
  )
    .bind(userId, serverId, Date.now())
    .run();
  return c.json({ id: server.id, name: server.name });
});

servers.get('/servers', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.name, m.role FROM memberships m JOIN servers s ON s.id = m.server_id
     WHERE m.user_id = ? ORDER BY s.created_at ASC`,
  )
    .bind(c.get('userId'))
    .all<{ id: string; name: string; role: string }>();
  return c.json(rows.results);
});

servers.post('/servers/:id/channels', async (c) => {
  const serverId = c.req.param('id');
  const parsed = createChannelSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: 'invalid' }, 400);
  const { name, kind, password } = parsed.data;

  // Owner-only. Nonexistent server or non-owner → 403 (no existence leak).
  const server = await c.env.DB.prepare('SELECT owner_id FROM servers WHERE id = ?')
    .bind(serverId)
    .first<{ owner_id: string }>();
  if (!server || server.owner_id !== c.get('userId')) return c.json({ code: 'forbidden' }, 403);

  let pwHash: Uint8Array | null = null;
  let pwSalt: Uint8Array | null = null;
  if (password) {
    const h = await pw.hashPassword(password);
    pwHash = h.hash;
    pwSalt = h.salt;
  }
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO channels (id, server_id, name, kind, pw_hash, pw_salt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, serverId, name, kind, pwHash, pwSalt, Date.now())
      .run();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e))) return c.json({ code: 'invalid', msg: 'name taken' }, 400);
    throw e;
  }
  return c.json({ id, name, kind, hasPassword: pwHash !== null }, 201);
});

servers.get('/servers/:id/channels', async (c) => {
  const serverId = c.req.param('id');
  const userId = c.get('userId');

  const member = await c.env.DB.prepare(
    'SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?',
  )
    .bind(userId, serverId)
    .first();
  if (!member) return c.json({ code: 'forbidden' }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.kind, (c.pw_hash IS NOT NULL) AS has_pw,
            (ca.user_id IS NOT NULL) AS has_access
     FROM channels c
     LEFT JOIN channel_access ca ON ca.channel_id = c.id AND ca.user_id = ?
     WHERE c.server_id = ? ORDER BY c.position ASC, c.created_at ASC`,
  )
    .bind(userId, serverId)
    .all<{ id: string; name: string; kind: string; has_pw: number; has_access: number }>();

  return c.json(
    rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      hasPassword: r.has_pw === 1,
      // Password-less channels are always unlocked; locked ones need a channel_access row.
      unlocked: r.has_pw === 1 ? r.has_access === 1 : true,
    })),
  );
});

servers.post('/channels/:id/unlock', async (c) => {
  const channelId = c.req.param('id');
  const userId = c.get('userId');
  const parsed = unlockSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: 'invalid' }, 400);

  const ch = await c.env.DB.prepare('SELECT server_id, pw_hash, pw_salt FROM channels WHERE id = ?')
    .bind(channelId)
    .first<{ server_id: string; pw_hash: ArrayBuffer | null; pw_salt: ArrayBuffer | null }>();
  if (!ch) return c.json({ code: 'forbidden' }, 403); // no existence leak

  const member = await c.env.DB.prepare(
    'SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?',
  )
    .bind(userId, ch.server_id)
    .first();
  if (!member) return c.json({ code: 'forbidden' }, 403);

  // Password-less channel: no-op, no row, no rate-limit consumed (§1).
  if (!ch.pw_hash || !ch.pw_salt) return c.body(null, 204);

  // Rate limit lives in the server's DO storage (fixed 60s window, injectable clock).
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(ch.server_id));
  const rl = await stub.fetch('https://do/internal/unlock-rate', {
    method: 'POST',
    body: JSON.stringify({ userId, channelId }),
  });
  const { allowed } = await rl.json<{ allowed: boolean }>();
  if (!allowed) return c.json({ code: 'rate_limited' }, 429);

  const ok = await pw.verifyPassword(
    parsed.data.password,
    new Uint8Array(ch.pw_salt),
    new Uint8Array(ch.pw_hash),
  );
  if (!ok) return c.json({ code: 'wrong_password' }, 403);

  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO channel_access (user_id, channel_id, granted_at) VALUES (?, ?, ?)',
  )
    .bind(userId, channelId, Date.now())
    .run();
  return c.body(null, 204);
});

export default servers;
