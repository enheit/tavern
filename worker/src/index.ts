import { Hono } from 'hono';
import authRoutes from './routes/auth';
import serverRoutes from './routes/servers';
import wsRoutes from './routes/ws';

export interface Env {
  DB: D1Database;
  AVATARS: R2Bucket;
  UPDATES: R2Bucket;
  SERVER_ROOM: DurableObjectNamespace;
  BUDGET_SOFT_GB: number;
  BUDGET_HARD_GB: number;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('ok'));
app.route('/api', authRoutes);
// WS route MUST be mounted before serverRoutes: serverRoutes has a `use('*',
// bearerAuth)` that would otherwise 401 the header-less WS upgrade (token is in
// ?token=). First-match wins in Hono, so ws wins for /servers/:id/ws.
app.route('/api', wsRoutes);
app.route('/api', serverRoutes);

export default app;

export { ServerRoom } from './server-room';
