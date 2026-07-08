import { Hono } from 'hono';
import authRoutes from './routes/auth';

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

export default app;

/**
 * Per-server coordination Durable Object (WS, presence, chat, RTC, budget).
 * Placeholder for Milestone 0; implemented in S2.4.
 */
export class ServerRoom {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(_req: Request): Promise<Response> {
    return new Response('server-room', { status: 200 });
  }
}
