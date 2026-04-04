import { Hono } from 'hono';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';

type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  JWT_SECRET: string;
  EMAIL_ROUTER: Fetcher;
};

type Variables = {
  auth: import('../types/api.js').AuthContext;
};

const adminEmail = new Hono<{ Bindings: Env; Variables: Variables }>();

adminEmail.use('*', authMiddleware, requireAdmin);

adminEmail.post('/test-banproof-email', async (c) => {
  const correlationId = crypto.randomUUID();
  const body = await c.req.json<{ email?: string }>().catch(() => null);
  const email = body?.email?.trim().toLowerCase();

  if (!email) {
    return c.json({ ok: false, error: 'email is required.', correlationId }, 400);
  }

  if (!email.endsWith('@banproof.me')) {
    return c.json({ ok: false, error: 'Only @banproof.me addresses are allowed.', correlationId }, 400);
  }

  if (!c.env.EMAIL_ROUTER || typeof c.env.EMAIL_ROUTER.fetch !== 'function') {
    return c.json({ ok: false, error: 'EMAIL_ROUTER binding is not configured.', correlationId }, 503);
  }

  try {
    const response = await c.env.EMAIL_ROUTER.fetch('https://email-router.internal/test-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        correlationId,
        triggeredBy: c.get('auth').userId,
      }),
    });

    if (!response.ok) {
      return c.json({ ok: false, status: 'dispatch_failed', correlationId }, 502);
    }

    return c.json({ ok: true, status: 'enqueued', correlationId, email }, 202);
  } catch {
    return c.json({ ok: false, status: 'dispatch_error', correlationId }, 502);
  }
});

export default adminEmail;
