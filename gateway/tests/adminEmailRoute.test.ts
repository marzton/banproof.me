import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('hono/jwt', () => ({
  verify: vi.fn(),
}));

import adminEmailRoutes from '../src/routes/adminEmail.js';
import { verify } from 'hono/jwt';

function makeSessionDb() {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => ({ revoked_at: null }),
      }),
      first: async () => ({ revoked_at: null }),
    }),
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: makeSessionDb(),
    CACHE: {},
    JWT_SECRET: 'test-secret',
    EMAIL_ROUTER: {
      fetch: vi.fn(async () => new Response(null, { status: 202 })),
    },
    ...overrides,
  } as any;
}

function makeRequest(email: string) {
  return new Request('http://localhost/api/admin/test-banproof-email', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer valid-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });
}

function buildApp() {
  const app = new Hono();
  app.route('/api/admin', adminEmailRoutes);
  return app;
}

describe('POST /api/admin/test-banproof-email', () => {
  beforeEach(() => {
    vi.mocked(verify).mockResolvedValue({
      sub: 'admin-user-1',
      email: 'admin@banproof.me',
      role: 'admin',
      tier: 'agency',
    } as never);
  });

  it('accepts @banproof.me emails', async () => {
    const emailFetch = vi.fn(async () => new Response(null, { status: 202 }));
    const env = makeEnv({ EMAIL_ROUTER: { fetch: emailFetch } });
    const app = buildApp();

    const res = await app.fetch(makeRequest('alerts@banproof.me'), env);

    expect(res.status).toBe(202);
    const body = await res.json() as { ok: boolean; status: string; correlationId: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('enqueued');
    expect(typeof body.correlationId).toBe('string');
    expect(emailFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects non-@banproof.me domains', async () => {
    const emailFetch = vi.fn(async () => new Response(null, { status: 202 }));
    const env = makeEnv({ EMAIL_ROUTER: { fetch: emailFetch } });
    const app = buildApp();

    const res = await app.fetch(makeRequest('alerts@example.com'), env);

    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/@banproof.me/i);
    expect(emailFetch).not.toHaveBeenCalled();
  });

  it('returns 503 when EMAIL_ROUTER binding is unavailable', async () => {
    const env = makeEnv({ EMAIL_ROUTER: undefined });
    const app = buildApp();

    const res = await app.fetch(makeRequest('alerts@banproof.me'), env);

    expect(res.status).toBe(503);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/binding/i);
  });
});
