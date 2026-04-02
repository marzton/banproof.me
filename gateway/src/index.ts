// ============================================================
// banproof-core — Gatekeeper Worker (Cloudflare Workers)
// ============================================================

import { Hono }           from 'hono';
import { cors }           from 'hono/cors';
import type { Workflow }   from '@cloudflare/workers-types';
import { BanproofEngine }  from './engine.js';
import authRoutes         from './routes/auth.js';
import adminRoutes        from './routes/admin.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimiter }    from './middleware/rateLimiter.js';
import { auditLogger }    from './middleware/auditLogger.js';

// ── Bindings type ─────────────────────────────────────────────
type Bindings = {
  DB:               D1Database;
  CACHE:            KVNamespace;
  ENGINE:           Workflow;
  JWT_SECRET:       string;
  USE_MOCK:         string;
  CORS_ORIGINS?:    string;
  HF_API_TOKEN?:    string;
  ODDS_API_KEY?:    string;
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
        ? c.env.CORS_ORIGINS.split(',').map((o: string) => o.trim())
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
// Auth-gated: requires a valid JWT session with Pro or Agency tier.
// Triggers a BanproofEngine workflow instance.
app.post(
  '/api/pro/analyze',
  authMiddleware,
  rateLimiter,
  auditLogger,
  async (c) => {
    const auth = c.var.auth;

    if (auth.tier === 'free') {
      return c.json(
        { error: 'Pro subscription required.', upgrade: '/pricing' },
        403,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON in request body.' }, 400);
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as { query?: unknown }).query !== 'string' ||
      !(body as { query: string }).query.trim()
    ) {
      return c.json(
        { error: '"query" (non-empty string) is required.' },
        400,
      );
    }

    const { query } = body as { query: string };
    const userId    = auth.userId;

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
export { BanproofEngine };
export default app;
