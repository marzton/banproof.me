// ============================================================
// banproof-core — Gatekeeper Worker (Cloudflare Workers)
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Workflow } from '@cloudflare/workers-types';
import { BanproofEngine } from './engine.js';

// ── Bindings type ─────────────────────────────────────────────
type Bindings = {
  DB:     D1Database;
  CACHE:  KVNamespace;
  ENGINE: Workflow;
};

const app = new Hono<{ Bindings: Bindings }>();

// ── CORS middleware ───────────────────────────────────────────
app.use(
  '/api/*',
  cors({
    origin: ['https://banproof.me', 'http://localhost:5500'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
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

// ── POST /api/pro/analyze ─────────────────────────────────────
// Triggers a BanproofEngine workflow instance.
app.post('/api/pro/analyze', async (c) => {
  const { query, userId } = await c.req.json<{
    query: string;
    userId: string;
  }>();

  if (!query || !userId) {
    return c.json({ error: 'query and userId are required.' }, 400);
  }

  const instance = await c.env.ENGINE.create({
    params: { query, userId },
  });

  return c.json({ workflowId: instance.id }, 202);
});

// ── Exports ───────────────────────────────────────────────────
export { BanproofEngine };
export default app;
