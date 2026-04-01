// ============================================================
// banproof-core — Gatekeeper Worker
// ============================================================
// Request flow:
//   1. /api/public/*   → Turnstile only
//   2. /api/protected/* → Turnstile + auth + free/pro OK
//   3. /api/pro/*      → Turnstile + auth + Pro tier required
//   4. /api/admin/*    → auth + admin tier required
//   5. /api/webhooks/* → raw (Stripe signature verified inline)
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import type { Env, Variables } from './types.js';
import { turnstile } from './middleware/turnstile.js';
import { auth, requireAdmin, requirePro } from './middleware/auth.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Global middleware ─────────────────────────────────────────

app.use('*', logger());
app.use('*', secureHeaders());
app.use(
  '/api/*',
  cors({
    origin: ['https://banproof.me', 'http://localhost:8788'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'cf-turnstile-response',
    ],
    credentials: true,
  }),
);

// ── Health check (no auth) ────────────────────────────────────

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    worker: 'banproof-core',
    env: c.env.ENVIRONMENT,
    ts: new Date().toISOString(),
  }),
);

// ── Public routes (Turnstile bot protection only) ─────────────

app.use('/api/public/*', turnstile);

app.post('/api/public/register', async (c) => {
  const { email, name } = await c.req.json<{ email: string; name: string }>();
  if (!email || !name) {
    return c.json({ error: 'email and name are required.' }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO users (id, email) VALUES (?, ?)
       ON CONFLICT(email) DO NOTHING`,
  )
    .bind(id, email.toLowerCase().trim())
    .run();

  await c.env.DB.prepare(
    `INSERT INTO audit_log (action, metadata, ip)
       VALUES ('register', ?, ?)`,
  )
    .bind(JSON.stringify({ email, name }), c.req.header('CF-Connecting-IP') ?? '')
    .run();

  return c.json({ ok: true, id }, 201);
});

app.get('/api/public/cms/:slug', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT title, body, category, updated_at
       FROM cms_content WHERE slug = ? AND published = 1 LIMIT 1`,
  )
    .bind(c.req.param('slug'))
    .first();

  if (!row) return c.json({ error: 'Not found.' }, 404);
  return c.json(row);
});

// ── Protected routes (auth required, free + pro) ──────────────

app.use('/api/protected/*', turnstile, auth);

app.get('/api/protected/me', (c) => c.json(c.var.user));

app.get('/api/protected/cms', async (c) => {
  const category = c.req.query('category') ?? '';
  const stmt = category
    ? c.env.DB.prepare(
        `SELECT slug, title, category, updated_at
           FROM cms_content WHERE published = 1 AND category = ?
           ORDER BY updated_at DESC LIMIT 50`,
      ).bind(category)
    : c.env.DB.prepare(
        `SELECT slug, title, category, updated_at
           FROM cms_content WHERE published = 1
           ORDER BY updated_at DESC LIMIT 50`,
      );

  const { results } = await stmt.all();
  return c.json(results);
});

// ── Pro routes (Pro or Admin tier required) ───────────────────

app.use('/api/pro/*', turnstile, auth, requirePro);

app.get('/api/pro/odds', async (c) => {
  // Placeholder — wire to The Odds API in a follow-up
  return c.json({
    message: 'Sports odds endpoint — connect Odds API key here.',
    hint:    'Add ODDS_API_KEY secret and call https://api.the-odds-api.com/v4/sports',
  });
});

app.post('/api/pro/ai/analyze', async (c) => {
  const { prompt } = await c.req.json<{ prompt: string }>();
  if (!prompt) return c.json({ error: 'prompt is required.' }, 400);

  // @ts-expect-error — Workers AI model types vary per model; cast as needed
  const result = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [{ role: 'user', content: prompt }],
  });

  return c.json(result);
});

// ── Admin routes (admin tier only, no Turnstile requirement) ──

app.use('/api/admin/*', auth, requireAdmin);

app.get('/api/admin/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, plan_tier, subscription_status, created_at
       FROM users ORDER BY created_at DESC LIMIT 100`,
  ).all();
  return c.json(results);
});

app.patch('/api/admin/users/:id/tier', async (c) => {
  const { tier } = await c.req.json<{ tier: string }>();
  const allowed  = ['free', 'pro', 'admin'];
  if (!allowed.includes(tier)) {
    return c.json({ error: `tier must be one of: ${allowed.join(', ')}` }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE users SET plan_tier = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
  )
    .bind(tier, c.req.param('id'))
    .run();

  // Invalidate cached session
  await c.env.CACHE.delete(`session:${c.req.param('id')}`);

  return c.json({ ok: true });
});

app.get('/api/admin/cms', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, title, category, published, updated_at
       FROM cms_content ORDER BY updated_at DESC`,
  ).all();
  return c.json(results);
});

app.post('/api/admin/cms', async (c) => {
  const { slug, title, body, category } = await c.req.json<{
    slug: string; title: string; body: string; category: string;
  }>();
  if (!slug || !title) return c.json({ error: 'slug and title required.' }, 400);

  const { meta } = await c.env.DB.prepare(
    `INSERT INTO cms_content (slug, title, body, category)
       VALUES (?, ?, ?, ?)`,
  )
    .bind(slug, title, body ?? '', category ?? 'general')
    .run();

  return c.json({ ok: true, id: meta.last_row_id }, 201);
});

// ── Stripe webhook (raw body, signature verified via HMAC-SHA256) ─

app.post('/api/webhooks/stripe', async (c) => {
  const payload   = await c.req.text();
  const signature = c.req.header('stripe-signature') ?? '';

  if (!signature || !c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json({ error: 'Webhook config incomplete.' }, 400);
  }

  // Parse the Stripe-Signature header: t=<timestamp>,v1=<hmac>
  const parts = Object.fromEntries(
    signature.split(',').map((p) => p.split('=')),
  ) as Record<string, string>;
  const timestamp = parts['t'];
  const v1sig     = parts['v1'];

  if (!timestamp || !v1sig) {
    return c.json({ error: 'Malformed Stripe-Signature header.' }, 400);
  }

  // Reject replays older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return c.json({ error: 'Webhook timestamp too old.' }, 400);
  }

  // Verify HMAC-SHA256: HMAC(secret, "<timestamp>.<payload>")
  const enc     = new TextEncoder();
  const keyData = enc.encode(c.env.STRIPE_WEBHOOK_SECRET);
  const message = enc.encode(`${timestamp}.${payload}`);

  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const sigBytes = Uint8Array.from(
    v1sig.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
  );
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, message);

  if (!valid) {
    return c.json({ error: 'Signature verification failed.' }, 403);
  }

  const event = JSON.parse(payload) as {
    type: string;
    data: { object: Record<string, unknown> };
  };

  switch (event.type) {
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub       = event.data.object as { customer: string; status: string };
      const newStatus = sub.status === 'active' ? 'active' : 'canceled';

      await c.env.DB.prepare(
        `UPDATE users SET subscription_status = ?, updated_at = CURRENT_TIMESTAMP
           WHERE stripe_customer_id = ?`,
      )
        .bind(newStatus, sub.customer)
        .run();
      break;
    }
    case 'checkout.session.completed': {
      const session = event.data.object as {
        customer: string; customer_email: string;
      };
      await c.env.DB.prepare(
        `UPDATE users
           SET stripe_customer_id = ?, plan_tier = 'pro',
               subscription_status = 'active',
               updated_at = CURRENT_TIMESTAMP
           WHERE email = ?`,
      )
        .bind(session.customer, session.customer_email?.toLowerCase())
        .run();
      break;
    }
  }

  return c.json({ received: true });
});

// ── Fallback ──────────────────────────────────────────────────

app.notFound((c) => c.json({ error: 'Route not found.' }, 404));
app.onError((err, c) => {
  console.error('[banproof-core]', err);
  return c.json({ error: 'Internal server error.' }, 500);
});

export default app;
