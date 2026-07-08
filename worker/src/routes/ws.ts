import { Hono } from 'hono';
import type { Env } from '../index';
import { hashToken } from '../lib/crypto';

// WebSocket upgrade (PLAN §1). Auth is via ?token= (not the bearer header), so
// this router is intentionally NOT under the bearerAuth middleware. The Worker
// validates token + membership against D1 pre-upgrade, then forwards to the
// per-server DO with the userId/serverId in headers.
const ws = new Hono<{ Bindings: Env }>();

ws.get('/servers/:id/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('expected websocket', 426);
  const serverId = c.req.param('id');
  const token = c.req.query('token');
  if (!token) return c.text('unauthorized', 401);

  const session = await c.env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ?')
    .bind(await hashToken(token))
    .first<{ user_id: string }>();
  if (!session) return c.text('unauthorized', 401);

  const member = await c.env.DB.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND server_id = ?')
    .bind(session.user_id, serverId)
    .first();
  if (!member) return c.text('forbidden', 403);

  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Tavern-User', session.user_id);
  headers.set('X-Tavern-Server', serverId);
  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(serverId));
  // Clone from the original request so the websocket-upgrade nature is preserved.
  return stub.fetch(new Request(c.req.raw, { headers }));
});

export default ws;
