import { Hono } from 'hono';
import authRoutes from './routes/auth';
import rtcRoutes from './routes/rtc';
import serverRoutes from './routes/servers';
import wsRoutes from './routes/ws';

export interface Env {
  DB: D1Database;
  AVATARS: R2Bucket;
  UPDATES: R2Bucket;
  SERVER_ROOM: DurableObjectNamespace;
  BUDGET_SOFT_GB: number;
  BUDGET_HARD_GB: number;
  // Realtime SFU credentials (dev: worker/.dev.vars; prod: var + secret). Used
  // ONLY server-side (Worker/DO); the client never receives them.
  CF_APP_ID: string;
  CF_APP_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('ok'));

// S6.3 updater artifacts: manifest + platform bundles live in R2 `tavern-updates`.
// The manifest is tiny and hot → 60 s edge/browser cache (§1).
app.get('/updates/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const obj = await c.env.UPDATES.get(key);
  if (!obj) return c.json({ code: 'not_found' }, 404);
  const type = key.endsWith('.json')
    ? 'application/json'
    : (obj.httpMetadata?.contentType ?? 'application/octet-stream');
  return new Response(obj.body, {
    headers: { 'content-type': type, 'cache-control': 'public, max-age=60' },
  });
});

app.route('/api', authRoutes);
// WS route MUST be mounted before serverRoutes: serverRoutes has a `use('*',
// bearerAuth)` that would otherwise 401 the header-less WS upgrade (token is in
// ?token=). First-match wins in Hono, so ws wins for /servers/:id/ws.
app.route('/api', wsRoutes);
app.route('/api', rtcRoutes);
app.route('/api', serverRoutes);

export default app;

export { ServerRoom } from './server-room';
