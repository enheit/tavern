import { Hono } from 'hono';
import authRoutes from './routes/auth';
import serverRoutes from './routes/servers';

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
app.route('/api', serverRoutes);

export default app;

const UNLOCK_WINDOW_MS = 60_000; // §1: fixed 60 s window from first attempt.
const UNLOCK_MAX_ATTEMPTS = 5; // 6th attempt in window → 429.

/**
 * Per-server coordination Durable Object (WS, presence, chat, RTC, budget).
 * S2.3 wires only the unlock rate-limit counter; WS/presence/chat land in S2.4.
 */
export class ServerRoom {
  // Injectable clock (§1 Time): tests override via runInDurableObject.
  nowMs: () => number = () => Date.now();

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/internal/unlock-rate') {
      const { userId, channelId } = await req.json<{ userId: string; channelId: string }>();
      return Response.json({ allowed: await this.consumeUnlockAttempt(userId, channelId) });
    }
    return new Response('server-room', { status: 200 });
  }

  // Fixed-window counter keyed per (user, channel). Returns false on the 6th
  // attempt within the window; the window resets 60 s after the first attempt.
  private async consumeUnlockAttempt(userId: string, channelId: string): Promise<boolean> {
    const key = `unlock:${userId}:${channelId}`;
    const now = this.nowMs();
    const cur = await this.ctx.storage.get<{ count: number; windowStart: number }>(key);
    if (!cur || now - cur.windowStart >= UNLOCK_WINDOW_MS) {
      await this.ctx.storage.put(key, { count: 1, windowStart: now });
      return true;
    }
    const next = { count: cur.count + 1, windowStart: cur.windowStart };
    await this.ctx.storage.put(key, next);
    return next.count <= UNLOCK_MAX_ATTEMPTS;
  }
}
