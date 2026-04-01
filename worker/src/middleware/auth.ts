// ============================================================
// Auth middleware
// Checks session token → KV cache → D1 database.
// Sets c.var.user for downstream handlers.
//
// Usage:
//   app.use('/api/protected/*', auth);
//   app.use('/api/pro/*',       auth, requirePro);
// ============================================================

import { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, User, Variables } from '../types.js';

const SESSION_TTL = 300; // 5 minutes KV cache TTL

export const auth: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const sessionToken =
    authHeader?.replace('Bearer ', '') ?? getCookie(c, 'session') ?? null;

  if (!sessionToken) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  // 1. Check KV cache
  const cached = await c.env.CACHE.get<
    Pick<User, 'id' | 'email' | 'plan_tier' | 'subscription_status'>
  >(`session:${sessionToken}`, 'json');

  if (cached) {
    c.set('user', cached);
    return next();
  }

  // 2. Fall back to D1 sessions table
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.plan_tier, u.subscription_status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
        AND s.expires_at > CURRENT_TIMESTAMP
      LIMIT 1`,
  )
    .bind(sessionToken)
    .first<Pick<User, 'id' | 'email' | 'plan_tier' | 'subscription_status'>>();

  if (!row) {
    return c.json({ error: 'Invalid or expired session.' }, 401);
  }

  const user = row;

  if (
    user.subscription_status === 'past_due' ||
    user.subscription_status === 'canceled'
  ) {
    return c.json(
      { error: 'Subscription inactive.', plan: user.plan_tier },
      402,
    );
  }

  // 3. Populate KV cache
  await c.env.CACHE.put(
    `session:${sessionToken}`,
    JSON.stringify(user),
    { expirationTtl: SESSION_TTL },
  );

  c.set('user', user);
  await next();
};

// ── Tier guard ────────────────────────────────────────────────

export const requirePro: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const user = c.var.user;
  if (user.plan_tier === 'free') {
    return c.json(
      { error: 'Pro subscription required.', upgrade: '/pricing' },
      403,
    );
  }
  await next();
};

export const requireAdmin: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const user = c.var.user;
  if (user.plan_tier !== 'admin') {
    return c.json({ error: 'Admin access required.' }, 403);
  }
  await next();
};

// ── Helpers ───────────────────────────────────────────────────

export function getUser(
  c: Context<{ Bindings: Env; Variables: Variables }>,
) {
  return c.var.user;
}
