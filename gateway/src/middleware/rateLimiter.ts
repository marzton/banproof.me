// ============================================================
// Rate Limiter Middleware — KV-based per-tier enforcement
// ============================================================
//
// Tiers:
//   free   → 10 req/min  (hard reject at limit)
//   pro    → 100 req/min (warning header at 90 %)
//   agency → unlimited   (bypass this middleware)
//
// KV key format: ratelimit:{userId}:{minuteTimestamp}
// ============================================================

import type { MiddlewareHandler } from 'hono';
import type { AuditAction } from '../types/api.js';

const TIER_LIMITS: Record<string, number | null> = {
  free:   10,
  pro:    100,
  agency: null, // unlimited
};

export const rateLimiter: MiddlewareHandler = async (c, next) => {
  const userId: string = c.req.header('X-User-Id') ?? 'anonymous';
  const tier: string   = (c.req.header('X-User-Tier') ?? 'free').toLowerCase();

  // Agency tier bypasses all rate limiting
  if (tier === 'agency') {
    await next();
    return;
  }

  const limit = TIER_LIMITS[tier] ?? TIER_LIMITS['free']!;
  const minuteTs = Math.floor(Date.now() / 60_000);
  const kvKey    = `ratelimit:${userId}:${minuteTs}`;

  const cache: KVNamespace = (c.env as any).CACHE;

  // Increment counter atomically within the current minute window
  let count = 1;
  const stored = await cache.get(kvKey);
  if (stored !== null) {
    count = parseInt(stored, 10) + 1;
  }

  // Hard reject when limit is reached — skip KV write to avoid inflating count
  if (count > limit) {
    // Fire-and-forget audit log
    const db: D1Database = (c.env as any).DB;
    if (db) {
      const action: AuditAction = 'RATE_LIMIT_HIT';
      c.executionCtx?.waitUntil(
        db
          .prepare(
            `INSERT INTO audit_log (user_id, action, metadata) VALUES (?, ?, ?)`,
          )
          .bind(userId, action, JSON.stringify({ tier, limit, count }))
          .run()
          .catch(() => { /* non-blocking — swallow D1 errors */ }),
      );
    }

    const upgrade =
      tier === 'free'
        ? 'Upgrade to Pro (100 req/min) at https://banproof.me/#pricing'
        : 'Contact us for Agency (unlimited) access at https://banproof.me/#pricing';

    return c.json(
      {
        error: 'Rate limit exceeded.',
        tier,
        limit,
        upgrade,
      },
      429,
    );
  }

  // Warn pro users approaching their limit (90 %)
  if (tier === 'pro' && count >= limit * 0.9) {
    c.header('X-RateLimit-Warning', 'Approaching limit');
  }

  // Only write to KV when the request is allowed (TTL of 90 s covers current minute)
  await cache.put(kvKey, String(count), { expirationTtl: 90 });

  c.header('X-RateLimit-Limit',     String(limit));
  c.header('X-RateLimit-Remaining', String(Math.max(0, limit - count)));

  await next();
};
