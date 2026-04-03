// ============================================================
// @goldshore/identity — Session-based auth middleware
//
// Checks the Bearer token / session cookie against the KV
// cache, falling back to the D1 sessions table on a miss.
// Sets c.var.user for downstream handlers.
//
// Usage (any worker whose Bindings extends IdentityEnv):
//   app.use('/api/protected/*', authMiddleware);
//   app.use('/api/pro/*',       authMiddleware, requirePro);
//   app.use('/api/admin/*',     authMiddleware, requireAdmin);
// ============================================================

import { MiddlewareHandler } from 'hono';
import { getCookie }         from 'hono/cookie';
import type { IdentityEnv, IdentityVariables, User } from '../types.js';

// Maximum KV cache TTL; actual TTL is min(SESSION_TTL, remaining session lifetime).
const SESSION_TTL = 300;

// Shape stored in KV — user fields plus expiry for cache-hit validation.
type CachedSession = Pick<
  User,
  'id' | 'email' | 'plan_tier' | 'subscription_status'
> & { expires_at: string };

export const authMiddleware: MiddlewareHandler<{
  Bindings: IdentityEnv;
  Variables: IdentityVariables;
}> = async (c, next) => {
  const authHeader   = c.req.header('Authorization');
  const sessionToken =
    authHeader?.replace('Bearer ', '') ?? getCookie(c, 'session') ?? null;

  if (!sessionToken) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  // 1. Check KV cache
  const cached = await c.env.CACHE.get<CachedSession>(
    `session:${sessionToken}`,
    'json',
  );

  if (cached) {
    // Belt-and-suspenders: reject if the cached session has already expired
    // (KV TTL should prevent this, but guards against clock skew).
    if (new Date(cached.expires_at).getTime() <= Date.now()) {
      await c.env.CACHE.delete(`session:${sessionToken}`);
      return c.json({ error: 'Session expired.' }, 401);
    }

    if (
      cached.subscription_status === 'past_due' ||
      cached.subscription_status === 'canceled'
    ) {
      return c.json(
        { error: 'Subscription inactive.', plan: cached.plan_tier },
        402,
      );
    }

    c.set('user', {
      id:                  cached.id,
      email:               cached.email,
      plan_tier:           cached.plan_tier,
      subscription_status: cached.subscription_status,
    });
    return next();
  }

  // 2. Fall back to D1 sessions table
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.plan_tier, u.subscription_status, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
        AND s.expires_at > CURRENT_TIMESTAMP
      LIMIT 1`,
  )
    .bind(sessionToken)
    .first<
      Pick<User, 'id' | 'email' | 'plan_tier' | 'subscription_status'> & {
        expires_at: string;
      }
    >();

  if (!row) {
    return c.json({ error: 'Invalid or expired session.' }, 401);
  }

  if (
    row.subscription_status === 'past_due' ||
    row.subscription_status === 'canceled'
  ) {
    return c.json(
      { error: 'Subscription inactive.', plan: row.plan_tier },
      402,
    );
  }

  // 3. Cache with TTL bounded by the remaining session lifetime
  const remainingSeconds = Math.floor(
    (new Date(row.expires_at).getTime() - Date.now()) / 1000,
  );
  const cacheTtl = Math.max(1, Math.min(SESSION_TTL, remainingSeconds));

  const { expires_at, ...userFields } = row;
  await c.env.CACHE.put(
    `session:${sessionToken}`,
    JSON.stringify({ ...userFields, expires_at } satisfies CachedSession),
    { expirationTtl: cacheTtl },
  );

  c.set('user', userFields);
  return next();
};

// ── Tier guards ───────────────────────────────────────────────

export const requirePro: MiddlewareHandler<{
  Bindings: IdentityEnv;
  Variables: IdentityVariables;
}> = async (c, next) => {
  if (c.var.user.plan_tier === 'free') {
    return c.json(
      { error: 'Pro subscription required.', upgrade: '/pricing' },
      403,
    );
  }
  return next();
};

export const requireAdmin: MiddlewareHandler<{
  Bindings: IdentityEnv;
  Variables: IdentityVariables;
}> = async (c, next) => {
  if (c.var.user.plan_tier !== 'admin') {
    return c.json({ error: 'Admin access required.' }, 403);
  }
  return next();
};
