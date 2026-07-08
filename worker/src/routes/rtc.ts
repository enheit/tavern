import { type Context, Hono } from 'hono';
import type { Env } from '../index';
import { type AuthVars, bearerAuth } from '../middleware/auth';

type RtcContext = Context<{ Bindings: Env; Variables: AuthVars }>;

// RTC signaling proxy (PLAN §1 Media-signaling). Thin: authenticate, resolve the
// channel's server DO, and forward to the DO which authorizes, rate-limits,
// calls the SFU (server-side, secret never leaves), and keeps the track
// registry + budget accrual. The SFU response is returned verbatim under `sfu`.
const rtc = new Hono<{ Bindings: Env; Variables: AuthVars }>();
rtc.use('*', bearerAuth);

const OPS = ['session', 'publish', 'subscribe', 'unsubscribe', 'renegotiate', 'unpublish', 'close'] as const;

async function forward(c: RtcContext, op: string): Promise<Response> {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const channelId = String(body.channelId ?? '');
  const ch = await c.env.DB.prepare('SELECT server_id FROM channels WHERE id = ?')
    .bind(channelId)
    .first<{ server_id: string }>();
  if (!ch) return c.json({ code: 'invalid' }, 400);

  const stub = c.env.SERVER_ROOM.get(c.env.SERVER_ROOM.idFromName(ch.server_id));
  const res = await stub.fetch(`https://do/internal/rtc/${op}`, {
    method: 'POST',
    body: JSON.stringify({ ...body, userId: c.get('userId'), serverId: ch.server_id }),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}

for (const op of OPS) rtc.post(`/rtc/${op}`, (c) => forward(c, op));

export default rtc;
