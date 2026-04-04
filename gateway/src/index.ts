// ============================================================
// banproof-core — Gatekeeper Worker (Cloudflare Workers)
// ============================================================

import { Hono }        from 'hono';
import { cors }        from 'hono/cors';
import type { Workflow, MessageBatch, Ai } from '@cloudflare/workers-types';
import { BanproofEngine } from './engine.js';
import { rateLimiter }   from './middleware/rateLimiter.js';
import { auditLogger }   from './middleware/auditLogger.js';
import { authMiddleware } from './middleware/auth.js';
import { tollBoothMiddleware } from './middleware/tollBooth.js';
import authRoutes      from './routes/auth.js';
import adminRoutes     from './routes/admin.js';
import adminEmailRoutes from './routes/adminEmail.js';

// ── Bindings type ─────────────────────────────────────────────
type Bindings = {
  DB:               D1Database;
  CACHE:            KVNamespace;
  INFRA_SECRETS:    KVNamespace;
  ENGINE:           Workflow;
  STORAGE:          R2Bucket;
  AI:               Ai;
  ENVIRONMENT:      string;
  USE_MOCK:         string;
  JWT_SECRET:       string;
  CORS_ORIGINS?:    string;
  HF_API_TOKEN?:    string;
  ODDS_API_KEY?:    string;
  DISCORD_WEBHOOK?: string;
  /** Service binding → saas-admin-template-customer-workflow */
  WORKFLOW:         Fetcher;
  /** Service binding → banproof-email-router */
  EMAIL_ROUTER:     Fetcher;
  /** Queue producer → goldshore-jobs */
  QUEUE:            Queue<QueueJobMessage>;
};

type Variables = {
  auth: import('./types/api.js').AuthContext;
  poaScore?: number;
};

// ── Queue message schema ──────────────────────────────────────
type QueueJobMessage = {
  /** Discriminates the job variant (e.g. 'sync_user', 'send_email'). */
  type: string;
  payload: Record<string, unknown>;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── CORS middleware ───────────────────────────────────────────
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      const allowList = c.env.CORS_ORIGINS
        ? c.env.CORS_ORIGINS.split(',').map((o) => o.trim())
        : ['https://banproof.me', 'http://localhost:5500', 'http://localhost:8788'];
      return allowList.includes(origin) ? origin : null;
    },
    allowMethods:  ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders:  ['Content-Type', 'Authorization', 'X-User-Id', 'X-User-Tier'],
    credentials:   true,
  }),
);

// ── GET /api/health ───────────────────────────────────────────
app.get('/api/health', async (c) => {
  let database = false;
  try {
    await c.env.DB.prepare('SELECT 1').first();
    database = true;
  } catch {
    // D1 not reachable
  }

  const workflow = typeof c.env.ENGINE?.create === 'function';

  return c.json({
    status:   'ok',
    database,
    workflow,
    mock:     c.env.USE_MOCK !== 'false',
    ts:       new Date().toISOString(),
  });
  return c.json({ success: true, workflowId: instance.id });
});

// ── Auth routes (/auth/*) ─────────────────────────────────────
app.route('/auth', authRoutes);

// ── Admin routes (/admin/*) ───────────────────────────────────
app.route('/admin', adminRoutes);
app.route('/api/admin', adminEmailRoutes);

// ── POST /api/pro/analyze ─────────────────────────────────────
// Triggers a BanproofEngine workflow instance.
// Requires valid JWT auth AND passes through the Toll Booth.
app.post(
  '/api/pro/analyze',
  authMiddleware,
  tollBoothMiddleware,
  rateLimiter,
  auditLogger,
  async (c) => {
    const body = await c.req.json<{
      query: string;
    }>().catch(() => null);

    if (!body || typeof body.query !== 'string') {
      return c.json({ error: 'query (string) is required.' }, 400);
    }

    const auth = c.get('auth');
    if (!auth?.userId) {
      return c.json({ error: 'Missing or invalid user identity' }, 401);
    }

    const instance = await c.env.ENGINE.create({
      params: {
        query: body.query,
        userId: auth.userId,
        useMock: c.env.USE_MOCK === 'true'
      },
    });

    return c.json({
      workflowId: instance.id,
      poaScore: c.get('poaScore')
    }, 202);
  },
);

// ── Fallback ──────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'Route not found.' }, 404));
app.onError((err, c) => {
  console.error('[banproof-core]', err);
  return c.json({ error: 'Internal server error.' }, 500);
});

// ── Exports ───────────────────────────────────────────────────
export { BanproofEngine };

export default {
  fetch: app.fetch.bind(app),

  // ── Queue consumer: goldshore-jobs ─────────────────────────
  async queue(
    batch: MessageBatch<QueueJobMessage>,
    _env: Bindings,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        // TODO: dispatch message.body.type to the appropriate handler.
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
};
