import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tollBoothMiddleware } from './tollBooth.js';

// ── Helpers ────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  app.use('/api/*', tollBoothMiddleware);
  app.get('/api/ping', (c: any) => {
    return c.json({ ok: true, poaScore: c.get('poaScore') });
  });
  return app;
}

function makeRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, { headers });
}

const VALID_TOKEN = 'secret_agent_key_2026';
const TRUSTED_IP = '100.100.100.1';

// ── Tests ──────────────────────────────────────────────────────────

describe('tollBoothMiddleware', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const app = buildApp();
    const res = await app.fetch(makeRequest('/api/ping'));
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toMatch(/Unauthorized/i);
  });

  it('returns 401 when Authorization header is present but has no Bearer token', async () => {
    const app = buildApp();
    const res = await app.fetch(makeRequest('/api/ping', {
      Authorization: 'Basic dXNlcjpwYXNz',
    }));
    expect(res.status).toBe(401);
  });

  it('returns 401 for an empty Bearer token', async () => {
    const app = buildApp();
    const res = await app.fetch(makeRequest('/api/ping', {
      Authorization: 'Bearer ',
    }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when token is wrong', async () => {
    const app = buildApp();
    const res = await app.fetch(makeRequest('/api/ping', {
      Authorization: 'Bearer bad_token',
    }));
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toMatch(/Proof of Agency/i);
  });

  it('returns 403 when token is valid but IP is untrusted', async () => {
    const app = buildApp();
    const res = await app.fetch(makeRequest('/api/ping', {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'X-Forwarded-For': '203.0.113.42',
    }));
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toMatch(/DePIN/i);
  });

  it('passes through and sets poaScore for a trusted request (Tailscale IP)', async () => {
    const app = buildApp();
    const res = await app.fetch(makeRequest('/api/ping', {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'X-Forwarded-For': TRUSTED_IP,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.poaScore).toBe(95);
  });

  it('passes through when IP header is absent (treated as "unknown")', async () => {
    const app = buildApp();
    const res = await app.fetch(makeRequest('/api/ping', {
      Authorization: `Bearer ${VALID_TOKEN}`,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.poaScore).toBe(95);
  });

  it('does NOT apply to public routes outside /api/*', async () => {
    const app = buildApp();
    // Route not under /api/ — middleware should not run
    app.get('/public/health', (c: any) => c.json({ ok: true }));
    const res = await app.fetch(makeRequest('/public/health'));
    expect(res.status).toBe(200);
  });
});
