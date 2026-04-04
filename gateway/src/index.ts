// ============================================================
// banproof-core — Gatekeeper Worker (Cloudflare Workers)
// ============================================================

import { Hono }        from 'hono';
import { cors }        from 'hono/cors';
import type { Workflow } from '@cloudflare/workers-types';
import { BanproofEngine } from './engine.js';
import { rateLimiter }   from './middleware/rateLimiter.js';
import { auditLogger }   from './middleware/auditLogger.js';
import authRoutes      from './routes/auth.js';
import adminRoutes     from './routes/admin.js';
import { authMiddleware } from './middleware/auth.js';

// ── Bindings type ─────────────────────────────────────────────
type Bindings = {
  DB:       D1Database;
  CACHE:    KVNamespace;
  ENGINE:   Workflow;
  STORAGE:  R2Bucket;
  /** Service binding → saas-admin-template-customer-workflow */
  WORKFLOW: Fetcher;
  /** Queue producer → goldshore-jobs */
  QUEUE:    Queue<QueueJobMessage>;
};

// ── Queue message schema ──────────────────────────────────────
type QueueJobMessage = {
  /** Discriminates the job variant (e.g. 'sync_user', 'send_email'). */
  type: string;
  payload: Record<string, unknown>;
  // D1 database
  DB:               D1Database;
  // KV namespaces
  CACHE:            KVNamespace;   // rate-limit windows
  INFRA_SECRETS:    KVNamespace;   // runtime secret store
  // Cloudflare Workflow
  ENGINE:           Workflow;
  // Cloudflare AI
  AI:               Ai;
  // [vars] — non-secret
  ENVIRONMENT:      string;
  USE_MOCK:         string;
  // Secrets (wrangler secret put)
  HF_API_TOKEN?:    string;
  ODDS_API_KEY?:    string;
  DISCORD_WEBHOOK?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// ── CORS middleware ───────────────────────────────────────────
app.use(
  '/api/*',
  cors({
    origin: ['https://banproof.me', 'http://localhost:5500'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'X-User-Tier'],
    credentials: true,
  }),
);

// ── GET /api/health ───────────────────────────────────────────
// Verifies D1 connectivity and that the Workflow binding exists.
app.get('/api/health', async (c) => {
  let database = false;
  try {
    await c.env.DB.prepare('SELECT 1').first();
    database = true;
  } catch {
    // D1 not reachable
  }

  const workflow = typeof c.env.ENGINE?.create === 'function';

  return c.json({ status: 'ok', database, workflow });
});

// Authorization middleware for Pro-only API routes
app.use('/api/pro/*', async (c, next) => {
  const plan = c.req.header('x-user-plan');

  if (plan !== 'pro') {
    return c.json({ error: 'Forbidden: Pro plan required' }, 403);
  }

  await next();
});
// ── POST /api/pro/analyze ─────────────────────────────────────
// Triggers a BanproofEngine workflow instance.
app.post('/api/pro/analyze', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { query?: unknown }).query !== 'string'
  ) {
    return c.json(
      { success: false, error: 'Invalid request body: "query" (string) is required' },
      400,
    );
  }

  const userId = c.req.header('x-user-id');
  if (!userId) {
    return c.json({ success: false, error: 'Missing or invalid user identity' }, 401);
  }

  const { query } = body as { query: string };

  const instance = await c.env.ENGINE.create({
    params: { query, userId },
  });

  return c.json({ workflowId: instance.id }, 202);
});

import { rateLimiter }   from './middleware/rateLimiter.js';
import { auditLogger }   from './middleware/auditLogger.js';

// ── Bindings type ─────────────────────────────────────────────
type Bindings = {
  DB:             D1Database;
  CACHE:          KVNamespace;
  ENGINE:         Workflow;
  JWT_SECRET:     string;
  USE_MOCK:       string;
  CORS_ORIGINS?:  string;
  HF_API_TOKEN?:  string;
  ODDS_API_KEY?:  string;
  DISCORD_WEBHOOK?: string;
};

type Variables = {
  auth: import('./types/api.js').AuthContext;
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
    allowHeaders:  ['Content-Type', 'Authorization'],
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
});

// ── Auth routes (/auth/*) ─────────────────────────────────────
app.route('/auth', authRoutes);

// ── Admin routes (/admin/*) ───────────────────────────────────
app.route('/admin', adminRoutes);

// ── POST /api/pro/analyze ─────────────────────────────────────
// Triggers a BanproofEngine workflow instance.
// Requires valid JWT auth.
app.post('/api/pro/analyze', authMiddleware, async (c) => {
  const { query, userId } = await c.req.json<{
    query:  string;
    userId: string;
  }>();
app.post(
  '/api/pro/analyze',
  rateLimiter,
  auditLogger,
  async (c) => {
    const { query, userId } = await c.req.json<{
      query: string;
      userId: string;
    }>();

    if (!query || !userId) {
      return c.json({ error: 'query and userId are required.' }, 400);
    }

    const instance = await c.env.ENGINE.create({
      params: { query, userId, useMock: c.env.USE_MOCK === 'true' },
    });

    return c.json({ workflowId: instance.id }, 202);
  },
);

// ── Fallback ──────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'Route not found.' }, 404));
app.onError((err, c) => {
  console.error('[banproof-core]', err);
  return c.json({ error: 'Internal server error.' }, 500);
});

// ── Exports ───────────────────────────────────────────────────
// Export the Durable-Object–style engine class so Wrangler can
// register it as the [[workflows]] class_name.
export { BanproofEngine };

// Export as an ExportedHandler object so the runtime can invoke
// both the HTTP fetch handler (Hono) and the queue consumer.
export default {
  fetch: app.fetch.bind(app),

  // ── Queue consumer: goldshore-jobs ─────────────────────────
  // Invoked by the Cloudflare runtime for each message batch
  // delivered from the goldshore-jobs queue.
  async queue(
    batch: MessageBatch<QueueJobMessage>,
    _env: Bindings,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        // TODO: dispatch message.body.type to the appropriate handler.
        // Example: if (message.body.type === 'sync_user') { ... }
        message.ack();
      } catch {
        // Returning without ack() causes the runtime to retry the message.
        message.retry();
      }
    }
  },
};
