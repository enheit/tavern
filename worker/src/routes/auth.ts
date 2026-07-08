import { Hono } from 'hono';
import type { Env } from '../index';
import { hashPassword, hashToken, mintToken, verifyPassword } from '../lib/crypto';
import { loginSchema, patchMeSchema, registerSchema } from '../lib/schemas';
import { type AuthVars, bearerAuth } from '../middleware/auth';

// Auth + profile endpoints (PLAN §1 HTTP contract): register / login / logout /
// me / patch me / avatar upload + serve.
const auth = new Hono<{ Bindings: Env; Variables: AuthVars }>();

const DEFAULT_COLOR = '#8a8f98'; // users.nickname_color DB default (§1 D1 schema).
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp']; // §1 allowed types.
const AVATAR_MAX = 512 * 1024; // §1: avatar ≤ 512 KB.

type Profile = { userId: string; nickname: string; color: string; avatarKey: string | null };
const profileOf = (
  userId: string,
  nickname: string,
  color: string,
  avatarKey: string | null,
): Profile => ({ userId, nickname, color, avatarKey });

async function currentProfile(db: D1Database, userId: string): Promise<Profile | null> {
  const u = await db
    .prepare('SELECT id, nickname, nickname_color, avatar_key FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; nickname: string; nickname_color: string; avatar_key: string | null }>();
  return u ? profileOf(u.id, u.nickname, u.nickname_color, u.avatar_key) : null;
}

// Fan out a profile change to the DO of every server the user belongs to; each
// DO re-broadcasts a `profile` frame to its connected clients (§1).
async function broadcastProfile(env: Env, profile: Profile): Promise<void> {
  const servers = await env.DB.prepare('SELECT server_id FROM memberships WHERE user_id = ?')
    .bind(profile.userId)
    .all<{ server_id: string }>();
  await Promise.all(
    servers.results.map((s) =>
      env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(s.server_id)).fetch(
        'https://do/internal/profile',
        { method: 'POST', body: JSON.stringify(profile) },
      ),
    ),
  );
}

/** Mint a session token, store its sha256, return the raw token (never stored). */
async function issueSession(db: D1Database, userId: string, now: number): Promise<string> {
  const token = mintToken();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), userId, now, now)
    .run();
  return token;
}

auth.post('/register', async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: 'invalid', msg: 'validation failed' }, 400);

  const { nickname, password } = parsed.data;
  const { hash, salt, iterations } = await hashPassword(password);
  const userId = crypto.randomUUID();
  const now = Date.now();

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, nickname, pw_hash, pw_salt, pw_iterations, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(userId, nickname, hash, salt, iterations, now)
      .run();
  } catch (e) {
    // The COLLATE NOCASE UNIQUE index rejects case-insensitive duplicates.
    if (/UNIQUE|constraint/i.test(String(e))) return c.json({ code: 'nickname_taken' }, 409);
    throw e;
  }

  const token = await issueSession(c.env.DB, userId, now);
  return c.json({ userId, token, profile: profileOf(userId, nickname, DEFAULT_COLOR, null) }, 201);
});

auth.post('/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: 'invalid' }, 400);

  const { nickname, password } = parsed.data;
  // nickname column is COLLATE NOCASE → this matches case-insensitively.
  const row = await c.env.DB.prepare(
    'SELECT id, nickname, nickname_color, avatar_key, pw_hash, pw_salt, pw_iterations FROM users WHERE nickname = ?',
  )
    .bind(nickname)
    .first<{
      id: string;
      nickname: string;
      nickname_color: string;
      avatar_key: string | null;
      pw_hash: ArrayBuffer;
      pw_salt: ArrayBuffer;
      pw_iterations: number;
    }>();
  if (!row) return c.json({ code: 'invalid', msg: 'bad credentials' }, 401);

  const ok = await verifyPassword(
    password,
    new Uint8Array(row.pw_salt),
    new Uint8Array(row.pw_hash),
    row.pw_iterations,
  );
  if (!ok) return c.json({ code: 'invalid', msg: 'bad credentials' }, 401);

  const token = await issueSession(c.env.DB, row.id, Date.now());
  return c.json({
    userId: row.id,
    token,
    profile: profileOf(row.id, row.nickname, row.nickname_color, row.avatar_key),
  });
});

auth.post('/logout', bearerAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.get('tokenHash')).run();
  return c.body(null, 204);
});

auth.get('/me', bearerAuth, async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare(
    'SELECT id, nickname, nickname_color, avatar_key FROM users WHERE id = ?',
  )
    .bind(userId)
    .first<{ id: string; nickname: string; nickname_color: string; avatar_key: string | null }>();
  if (!user) return c.json({ code: 'invalid' }, 401); // session valid but user gone

  const servers = await c.env.DB.prepare(
    `SELECT s.id, s.name FROM memberships m JOIN servers s ON s.id = m.server_id
     WHERE m.user_id = ? ORDER BY s.created_at ASC`,
  )
    .bind(userId)
    .all<{ id: string; name: string }>();

  return c.json({
    userId: user.id,
    nickname: user.nickname,
    color: user.nickname_color,
    avatarKey: user.avatar_key,
    servers: servers.results,
  });
});

auth.patch('/me', bearerAuth, async (c) => {
  const parsed = patchMeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: 'invalid' }, 400);
  const { nickname, color } = parsed.data;
  const userId = c.get('userId');

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (nickname !== undefined) {
    sets.push('nickname = ?');
    binds.push(nickname);
  }
  if (color !== undefined) {
    sets.push('nickname_color = ?');
    binds.push(color);
  }
  binds.push(userId);
  try {
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e))) return c.json({ code: 'nickname_taken' }, 409);
    throw e;
  }

  const profile = (await currentProfile(c.env.DB, userId))!;
  await broadcastProfile(c.env, profile);
  return c.json(profile);
});

auth.put('/me/avatar', bearerAuth, async (c) => {
  const ct = (c.req.header('content-type') ?? '').split(';')[0].trim();
  if (!AVATAR_TYPES.includes(ct)) return c.json({ code: 'unsupported_type' }, 415);
  // Reject oversize early by declared length, then enforce on the real bytes.
  if (Number(c.req.header('content-length') ?? '0') > AVATAR_MAX) return c.json({ code: 'too_large' }, 413);
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > AVATAR_MAX) return c.json({ code: 'too_large' }, 413);

  const userId = c.get('userId');
  await c.env.AVATARS.put(`avatars/${userId}`, buf, { httpMetadata: { contentType: ct } });
  const avatarKey = crypto.randomUUID().slice(0, 8); // version marker (also cache-bust token)
  await c.env.DB.prepare('UPDATE users SET avatar_key = ? WHERE id = ?').bind(avatarKey, userId).run();

  await broadcastProfile(c.env, (await currentProfile(c.env.DB, userId))!);
  return c.json({ avatarKey });
});

// Public avatar proxy (no auth). Serves the R2 object; 404 if none.
auth.get('/avatars/:userId', async (c) => {
  const obj = await c.env.AVATARS.get(`avatars/${c.req.param('userId')}`);
  if (!obj) return c.text('not found', 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=300',
    },
  });
});

export default auth;
