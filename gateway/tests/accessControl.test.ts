// ============================================================
// Access Control Middleware — Test Suite
// Tests Zero-Edge SSO + agent-token fallback + RBAC
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { accessControlMiddleware } from '../src/middleware/accessControl.js';
import type { ZeroEdgeIdentity, AccessContext } from '../src/types/access.js';

// ── Mock zeroEdgeSSO module ───────────────────────────────────
//
// We mock validateZeroEdgeJWT so tests don't need real RSA keys.
// extractClaims and enforceRBAC use their real implementations
// so RBAC logic is covered by integration.

vi.mock('../src/middleware/zeroEdgeSSO.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/middleware/zeroEdgeSSO.js')>();
  return {
    ...original,
    validateZeroEdgeJWT: vi.fn(),
  };
});

import { validateZeroEdgeJWT } from '../src/middleware/zeroEdgeSSO.js';

// ── Test helpers ──────────────────────────────────────────────

// Dev-only hardcoded token used by validateProofOfAgency in proofOfAgency.ts.
// NOT a real credential — see proofOfAgency.ts for context.
const VALID_TOKEN  = 'secret_agent_key_2026'; // PoA agent token
const TRUSTED_IP   = '100.100.100.1';
const UNTRUSTED_IP = '203.0.113.99';

/** Default env bindings provided to every app.fetch() call */
const BASE_ENV = {
  CF_ACCESS_AUDIENCE:      'https://banproof-core.marzton.workers.dev',
  CF_ZERO_EDGE_PUBLIC_KEY: 'MOCK_KEY',
  TRUSTED_ADMIN_IPS:       `${TRUSTED_IP},127.0.0.1,::1`,
};

function buildApp() {
  const app = new Hono<{ Variables: { accessContext: AccessContext } }>();

  app.use('*', accessControlMiddleware);

  // Protected routes
  app.post('/api/pro/analyze', (c) => c.json({ ok: true }));
  app.get('/admin/dashboard',  (c) => c.json({ ok: true }));
  app.post('/admin/config',    (c) => c.json({ ok: true }));
  // Public route
  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  return app;
}

/** Fetch helper — passes the env object as the second argument (Cloudflare Worker style) */
function doFetch(
  app: Hono<{ Variables: { accessContext: AccessContext } }>,
  request: Request,
  envOverrides: Record<string, string> = {},
) {
  return app.fetch(request, { ...BASE_ENV, ...envOverrides });
}

function makeIdentity(overrides: Partial<ZeroEdgeIdentity> = {}): ZeroEdgeIdentity {
  return {
    userId:    'user-123',
    email:     'user@banproof.me',
    role:      'pro',
    tierLevel: 'pro',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function jwtRequest(
  path: string,
  method = 'GET',
  ip = TRUSTED_IP,
  extraHeaders: Record<string, string> = {},
) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Cf-Access-Jwt-Assertion': 'mock.jwt.token',
      'CF-Connecting-IP': ip,
      ...extraHeaders,
    },
  });
}

function agentRequest(
  path: string,
  method = 'GET',
  ip = TRUSTED_IP,
) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Authorization':   `Bearer ${VALID_TOKEN}`,
      'CF-Connecting-IP': ip,
    },
  });
}

function publicRequest(path: string, method = 'GET', ip = TRUSTED_IP) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'CF-Connecting-IP': ip },
  });
}

// ── Test suite ────────────────────────────────────────────────

describe('accessControlMiddleware', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Public routes ─────────────────────────────────────────

  it('allows GET /api/health without any authentication', async () => {
    const app = buildApp();
    const res = await doFetch(app, publicRequest('/api/health'));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  // ── CORS preflight bypass ─────────────────────────────────

  it('allows OPTIONS on a protected route without auth (CORS preflight)', async () => {
    const app = buildApp();
    const req = new Request('http://localhost/api/pro/analyze', {
      method: 'OPTIONS',
      headers: { 'CF-Connecting-IP': TRUSTED_IP },
    });
    const res = await doFetch(app, req);
    // The middleware passes through; Hono returns 404 because no OPTIONS handler
    // is registered — the important thing is it is NOT 401/403.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('allows OPTIONS on an admin route without auth (CORS preflight)', async () => {
    const app = buildApp();
    const req = new Request('http://localhost/admin/config', {
      method: 'OPTIONS',
      headers: { 'CF-Connecting-IP': UNTRUSTED_IP },
    });
    const res = await doFetch(app, req);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  // ── Zero-Edge SSO — Pro tier ──────────────────────────────

  it('allows POST /api/pro/analyze with valid JWT + pro tier', async () => {
    vi.mocked(validateZeroEdgeJWT).mockResolvedValue(makeIdentity({ role: 'pro', tierLevel: 'pro' }));

    const app = buildApp();
    const res = await doFetch(app, jwtRequest('/api/pro/analyze', 'POST'));
    expect(res.status).toBe(200);
  });

  it('allows POST /api/pro/analyze with valid JWT + agency tier', async () => {
    vi.mocked(validateZeroEdgeJWT).mockResolvedValue(makeIdentity({ role: 'agency', tierLevel: 'agency' }));

    const app = buildApp();
    const res = await doFetch(app, jwtRequest('/api/pro/analyze', 'POST'));
    expect(res.status).toBe(200);
  });

  it('denies POST /api/pro/analyze with valid JWT + free tier (403)', async () => {
    vi.mocked(validateZeroEdgeJWT).mockResolvedValue(makeIdentity({ role: 'public', tierLevel: 'free' }));

    const app = buildApp();
    const res = await doFetch(app, jwtRequest('/api/pro/analyze', 'POST'));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/pro/i);
  });

  // ── Zero-Edge SSO — Admin ─────────────────────────────────

  it('allows GET /admin/dashboard with valid JWT + admin role from trusted IP', async () => {
    vi.mocked(validateZeroEdgeJWT).mockResolvedValue(makeIdentity({ role: 'admin', tierLevel: 'agency' }));

    const app = buildApp();
    const res = await doFetch(app, jwtRequest('/admin/dashboard', 'GET', TRUSTED_IP));
    expect(res.status).toBe(200);
  });

  it('allows POST /admin/config with admin role + trusted IP', async () => {
    vi.mocked(validateZeroEdgeJWT).mockResolvedValue(makeIdentity({ role: 'admin', tierLevel: 'agency' }));

    const app = buildApp();
    const res = await doFetch(app, jwtRequest('/admin/config', 'POST', TRUSTED_IP));
    expect(res.status).toBe(200);
  });

  it('denies POST /admin/config with admin role + untrusted IP (403)', async () => {
    vi.mocked(validateZeroEdgeJWT).mockResolvedValue(makeIdentity({ role: 'admin', tierLevel: 'agency' }));

    const app = buildApp();
    const res = await doFetch(app, jwtRequest('/admin/config', 'POST', UNTRUSTED_IP));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/whitelist/i);
  });

  it('denies GET /admin/dashboard with non-admin JWT (403)', async () => {
    vi.mocked(validateZeroEdgeJWT).mockResolvedValue(makeIdentity({ role: 'pro', tierLevel: 'pro' }));

    const app = buildApp();
    const res = await doFetch(app, jwtRequest('/admin/dashboard', 'GET', TRUSTED_IP));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/admin/i);
  });

  // ── Invalid JWT ───────────────────────────────────────────

  it('returns 401 when JWT signature is invalid', async () => {
    vi.mocked(validateZeroEdgeJWT).mockRejectedValue(new Error('Invalid JWT: signature verification failed'));

    const app = buildApp();
    const res = await doFetch(app, jwtRequest('/api/pro/analyze', 'POST'));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid/i);
  });

  it('returns 401 for expired JWT', async () => {
    vi.mocked(validateZeroEdgeJWT).mockRejectedValue(new Error('Invalid JWT: token has expired'));

    const app = buildApp();
    const res = await doFetch(app, jwtRequest('/api/pro/analyze', 'POST'));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid|expired/i);
  });

  it('returns 401 when JWT is present but invalid for any protected route', async () => {
    vi.mocked(validateZeroEdgeJWT).mockRejectedValue(new Error('Invalid JWT: malformed token'));

    const app = buildApp();
    // Test admin route too
    const res = await doFetch(app, jwtRequest('/admin/dashboard', 'GET'));
    expect(res.status).toBe(401);
  });

  // ── Agent token fallback ──────────────────────────────────

  it('allows POST /api/pro/analyze with valid agent token (no JWT)', async () => {
    const app = buildApp();
    const res = await doFetch(app, agentRequest('/api/pro/analyze', 'POST', TRUSTED_IP));
    expect(res.status).toBe(200);
  });

  it('denies POST /api/pro/analyze with invalid agent token (returns 401 as public user)', async () => {
    const app = buildApp();
    const res = await doFetch(
      app,
      new Request('http://localhost/api/pro/analyze', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer bad_token',
          'CF-Connecting-IP': TRUSTED_IP,
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  // ── Unauthenticated access to protected routes ────────────

  it('returns 401 for unauthenticated access to POST /api/pro/analyze', async () => {
    const app = buildApp();
    const res = await doFetch(app, publicRequest('/api/pro/analyze', 'POST'));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/pro/i);
  });

  it('returns 401 for unauthenticated access to GET /admin/dashboard', async () => {
    const app = buildApp();
    const res = await doFetch(app, publicRequest('/admin/dashboard'));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/admin/i);
  });

  // ── Context attachment ────────────────────────────────────

  it('attaches accessContext to request when using Zero-Edge SSO', async () => {
    const identity = makeIdentity({ role: 'pro', tierLevel: 'pro' });
    vi.mocked(validateZeroEdgeJWT).mockResolvedValue(identity);

    const app = buildApp();

    // Add a route that reads the context
    app.post('/api/pro/context-check', (c) => {
      const ctx = c.get('accessContext') as AccessContext;
      return c.json({ method: ctx?.method, role: ctx?.identity.role });
    });

    const res = await doFetch(app, jwtRequest('/api/pro/context-check', 'POST'));
    expect(res.status).toBe(200);
    const body = await res.json() as { method: string; role: string };
    expect(body.method).toBe('zero-edge-sso');
    expect(body.role).toBe('pro');
  });

  it('attaches accessContext with method agent-token when using Bearer auth', async () => {
    const app = buildApp();

    app.post('/api/pro/context-check', (c) => {
      const ctx = c.get('accessContext') as AccessContext;
      return c.json({ method: ctx?.method });
    });

    const res = await doFetch(app, agentRequest('/api/pro/context-check', 'POST', TRUSTED_IP));
    expect(res.status).toBe(200);
    const body = await res.json() as { method: string };
    expect(body.method).toBe('agent-token');
  });
});
