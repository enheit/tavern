import { createMiddleware } from 'hono/factory';
import type { Env } from '../index';
import { hashToken } from '../lib/crypto';

export type AuthVars = { userId: string; tokenHash: string };

// Bearer auth (PLAN §1 "Auth"): look the token hash up in `sessions`, set the
// userId + tokenHash for the handler, and bump last_seen_at (informational).
// Missing or unknown token → 401. Sessions never expire (only logout deletes).
export const bearerAuth = createMiddleware<{ Bindings: Env; Variables: AuthVars }>(
  async (c, next) => {
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return c.json({ code: 'invalid', msg: 'missing token' }, 401);

    const tokenHash = await hashToken(token);
    const row = await c.env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .first<{ user_id: string }>();
    if (!row) return c.json({ code: 'invalid', msg: 'invalid token' }, 401);

    await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
      .bind(Date.now(), tokenHash)
      .run();

    c.set('userId', row.user_id);
    c.set('tokenHash', tokenHash);
    await next();
  },
);
