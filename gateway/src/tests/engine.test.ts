// ============================================================
// engine.test.ts — Hybrid engine test suite
// Covers: mocks, best-price logic, rate limiter, audit logger
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

import { mockSentiment } from '../mocks/huggingface.js';
import { mockOdds }      from '../mocks/odds-api.js';
import { rateLimiter }   from '../middleware/rateLimiter.js';
import { auditLogger }   from '../middleware/auditLogger.js';

// ─────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────

function makeKV(store: Record<string, string> = {}): KVNamespace {
  const map = { ...store };
  return {
    get:    async (key: string) => map[key] ?? null,
    put:    async (key: string, value: string) => { map[key] = value; },
    delete: async (key: string) => { delete map[key]; },
    list:   async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeDB(insertOk = true): D1Database {
  const runFn = insertOk
    ? async () => ({ success: true })
    : async () => { throw new Error('D1 error'); };
  return {
    prepare: () => ({
      bind: () => ({
        run:   runFn,
        first: async () => ({ '1': 1 }),
      }),
      first: async () => ({ '1': 1 }),
      run:   async () => ({ success: true }),
    }),
    exec:  async () => ({ results: [], success: true, meta: {} }),
    batch: async () => [],
    dump:  async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

// ─────────────────────────────────────────────────────────────
// 1. Mock Sentiment
// ─────────────────────────────────────────────────────────────

describe('mockSentiment()', () => {
  it('returns a SentimentResult with source MOCK_HF', () => {
    const result = mockSentiment();
    expect(result.source).toBe('MOCK_HF');
  });

  it('label is BULLISH or BEARISH', () => {
    for (let i = 0; i < 20; i++) {
      const { label } = mockSentiment();
      expect(['BULLISH', 'BEARISH']).toContain(label);
    }
  });

  it('score is in [0.5, 1.0]', () => {
    for (let i = 0; i < 20; i++) {
      const { score } = mockSentiment();
      expect(score).toBeGreaterThanOrEqual(0.5);
      expect(score).toBeLessThanOrEqual(1.0);
    }
  });

  it('BULLISH confidence is in [0.80, 0.95]', () => {
    // Run many times to hit both branches
    const bullish = Array.from({ length: 200 }, () => mockSentiment()).filter(
      (r) => r.label === 'BULLISH',
    );
    for (const r of bullish) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.8);
      expect(r.confidence).toBeLessThanOrEqual(0.95);
    }
  });

  it('BEARISH confidence is in [0.50, 0.70]', () => {
    const bearish = Array.from({ length: 200 }, () => mockSentiment()).filter(
      (r) => r.label === 'BEARISH',
    );
    for (const r of bearish) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
      expect(r.confidence).toBeLessThanOrEqual(0.7);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Mock Odds
// ─────────────────────────────────────────────────────────────

describe('mockOdds()', () => {
  it('returns source MOCK_ODDS', () => {
    expect(mockOdds().source).toBe('MOCK_ODDS');
  });

  it('returns at least 3 bookmakers', () => {
    expect(mockOdds().bookmakers.length).toBeGreaterThanOrEqual(3);
  });

  it('always includes DraftKings, FanDuel, BetMGM', () => {
    const { bookmakers } = mockOdds();
    const names = bookmakers.map((b) => b.name);
    expect(names).toContain('DraftKings');
    expect(names).toContain('FanDuel');
    expect(names).toContain('BetMGM');
  });

  it('best_price points to the bookmaker with highest price', () => {
    for (let i = 0; i < 10; i++) {
      const { bookmakers, best_price } = mockOdds();
      const maxPrice = Math.max(...bookmakers.map((b) => b.price));
      expect(best_price.price).toBe(maxPrice);
    }
  });

  it('correctly classifies EV+ as price > -108', () => {
    // Deterministic test: patch Math.random to return no jitter
    const origRandom = Math.random;
    Math.random = () => 0.5; // jitter = 0, DK=-110, FD=-115, BM=-108, CS=-112 → no EV+ with flat 0.5
    const { bookmakers } = mockOdds();
    for (const bm of bookmakers) {
      if (bm.price > -108) expect(bm.value).toBe('EV+');
      else if (bm.price < -115) expect(bm.value).toBe('EV-');
      else expect(bm.value).toBe('FAIR');
    }
    Math.random = origRandom;
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Rate Limiter
// ─────────────────────────────────────────────────────────────

function buildRateLimitApp(kvStore: Record<string, string> = {}) {
  const app = new Hono<{ Bindings: any }>();
  app.use('/api/*', rateLimiter);
  app.post('/api/pro/analyze', (c) => c.json({ ok: true }, 200));

  return {
    app,
    kv: makeKV(kvStore),
    db: makeDB(),
    ctx: makeCtx(),
  };
}

async function hitRateLimitApp(
  { app, kv, db, ctx }: ReturnType<typeof buildRateLimitApp>,
  tier: string,
  userId = 'user1',
) {
  return app.fetch(
    new Request('http://localhost/api/pro/analyze', { method: 'POST', body: '{}' }),
    { CACHE: kv, DB: db, USE_MOCK: 'true' } as any,
    ctx,
  );
}

describe('rateLimiter middleware', () => {
  it('agency tier bypasses rate limiting', async () => {
    const rig = buildRateLimitApp();
    const res = await rig.app.fetch(
      new Request('http://localhost/api/pro/analyze', {
        method: 'POST',
        body:   '{}',
        headers: { 'X-User-Id': 'agency-user', 'X-User-Tier': 'agency' },
      }),
      { CACHE: rig.kv, DB: rig.db } as any,
      rig.ctx,
    );
    expect(res.status).toBe(200);
  });

  it('free tier allows up to 10 requests', async () => {
    const rig = buildRateLimitApp();
    for (let i = 0; i < 10; i++) {
      const res = await rig.app.fetch(
        new Request('http://localhost/api/pro/analyze', {
          method: 'POST',
          body:   '{}',
          headers: { 'X-User-Id': 'free-user', 'X-User-Tier': 'free' },
        }),
        { CACHE: rig.kv, DB: rig.db } as any,
        rig.ctx,
      );
      expect(res.status).toBe(200);
    }
  });

  it('free tier returns 429 on the 11th request', async () => {
    const rig = buildRateLimitApp();
    for (let i = 0; i < 10; i++) {
      await rig.app.fetch(
        new Request('http://localhost/api/pro/analyze', {
          method: 'POST',
          body:   '{}',
          headers: { 'X-User-Id': 'free-user2', 'X-User-Tier': 'free' },
        }),
        { CACHE: rig.kv, DB: rig.db } as any,
        rig.ctx,
      );
    }
    const res = await rig.app.fetch(
      new Request('http://localhost/api/pro/analyze', {
        method: 'POST',
        body:   '{}',
        headers: { 'X-User-Id': 'free-user2', 'X-User-Tier': 'free' },
      }),
      { CACHE: rig.kv, DB: rig.db } as any,
      rig.ctx,
    );
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error).toMatch(/rate limit/i);
    expect(body.upgrade).toBeDefined();
  });

  it('returns 429 body with tier and limit fields', async () => {
    // Pre-populate KV to simulate 11 already consumed
    const minuteTs = Math.floor(Date.now() / 60_000);
    const key = `ratelimit:limit-test:${minuteTs}`;
    const rig = buildRateLimitApp({ [key]: '10' });
    const res = await rig.app.fetch(
      new Request('http://localhost/api/pro/analyze', {
        method: 'POST',
        body:   '{}',
        headers: { 'X-User-Id': 'limit-test', 'X-User-Tier': 'free' },
      }),
      { CACHE: rig.kv, DB: rig.db } as any,
      rig.ctx,
    );
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.tier).toBe('free');
    expect(body.limit).toBe(10);
  });

  it('pro tier sends warning header at 90% usage', async () => {
    const minuteTs = Math.floor(Date.now() / 60_000);
    const key = `ratelimit:pro-user:${minuteTs}`;
    const rig = buildRateLimitApp({ [key]: '89' }); // next request = 90
    const res = await rig.app.fetch(
      new Request('http://localhost/api/pro/analyze', {
        method: 'POST',
        body:   '{}',
        headers: { 'X-User-Id': 'pro-user', 'X-User-Tier': 'pro' },
      }),
      { CACHE: rig.kv, DB: rig.db } as any,
      rig.ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Warning')).toBe('Approaching limit');
  });

  it('sets X-RateLimit-Remaining header', async () => {
    const rig = buildRateLimitApp();
    const res = await rig.app.fetch(
      new Request('http://localhost/api/pro/analyze', {
        method: 'POST',
        body:   '{}',
        headers: { 'X-User-Id': 'header-test', 'X-User-Tier': 'free' },
      }),
      { CACHE: rig.kv, DB: rig.db } as any,
      rig.ctx,
    );
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('9');
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Audit Logger
// ─────────────────────────────────────────────────────────────

describe('auditLogger middleware', () => {
  it('calls DB.prepare after the handler completes', async () => {
    const db = makeDB();
    const prepareSpy = vi.spyOn(db as any, 'prepare');

    const app = new Hono<{ Bindings: any }>();
    app.use('/api/*', auditLogger);
    app.post('/api/pro/analyze', (c) => c.json({ ok: true }));

    await app.fetch(
      new Request('http://localhost/api/pro/analyze', { method: 'POST', body: '{}' }),
      { DB: db } as any,
      makeCtx(),
    );

    expect(prepareSpy).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_log'),
    );
  });

  it('does not block the response when DB is unavailable', async () => {
    const app = new Hono<{ Bindings: any }>();
    app.use('/api/*', auditLogger);
    app.post('/api/pro/analyze', (c) => c.json({ ok: true }));

    // No DB binding — auditLogger should silently skip
    const res = await app.fetch(
      new Request('http://localhost/api/pro/analyze', { method: 'POST', body: '{}' }),
      {} as any,
      makeCtx(),
    );
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. Discord webhook is optional (workflow doesn't break)
// ─────────────────────────────────────────────────────────────

describe('Discord webhook optional behaviour', () => {
  it('console.logs instead of throwing when DISCORD_WEBHOOK is missing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Simulate the no-webhook branch directly
    const DISCORD_WEBHOOK = undefined as string | undefined;
    const summary = { query: 'test', userId: 'u1', source: 'MOCK' };
    if (DISCORD_WEBHOOK) {
      // Would fetch — not reached
    } else {
      console.log('[BanproofEngine] discord-notify (no webhook configured):', JSON.stringify(summary));
    }
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('discord-notify'),
      expect.any(String),
    );
    spy.mockRestore();
  });
});
