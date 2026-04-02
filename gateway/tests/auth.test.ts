// ============================================================
// Auth tests — signup, signin, refresh, logout
// Uses Hono's in-process fetch with mocked D1 / KV / JWT_SECRET
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import authRoutes from '../src/routes/auth.js';

// ── Minimal D1 mock ───────────────────────────────────────────

function makeD1() {
  const rows: Record<string, Record<string, unknown>[]> = {
    users: [],
    sessions: [],
    audit_log: [],
  };

  const mockStmt = (sql: string, bindings: unknown[]) => ({
    first: async <T>() => {
      const sqlLower = sql.toLowerCase();

      if (sqlLower.includes('from users where email')) {
        const email = String(bindings[0]).toLowerCase();
        return (rows.users.find((u) => u.email === email) as T | undefined) ?? null;
      }
      if (sqlLower.includes('from users where id')) {
        return (rows.users.find((u) => u.id === bindings[0]) as T | undefined) ?? null;
      }
      // Auth middleware: SELECT revoked_at FROM sessions WHERE access_token = ? AND user_id = ?
      if (sqlLower.includes('from sessions') && sqlLower.includes('revoked_at') && sqlLower.includes('access_token')) {
        const token = bindings[0];
        const userId = bindings[1];
        const s = rows.sessions.find(
          (s) => s.access_token === token && s.user_id === userId,
        );
        return s ? ({ revoked_at: s.revoked_at ?? null } as T) : null;
      }
      // Refresh token lookup
      if (sqlLower.includes('from sessions') && sqlLower.includes('refresh_token')) {
        const s = rows.sessions.find((s) => s.refresh_token === bindings[0]);
        if (!s) return null;
        const u = rows.users.find((u) => u.id === s.user_id);
        return { ...s, ...(u ? { email: u.email, plan_tier: u.plan_tier, role: u.role } : {}) } as T;
      }
      // Logout lookup: SELECT user_id FROM sessions WHERE access_token = ?
      if (sqlLower.includes('from sessions') && sqlLower.includes('access_token')) {
        const s = rows.sessions.find((s) => s.access_token === bindings[0]);
        return s ? ({ user_id: s.user_id } as T) : null;
      }
      return null;
    },
    run: async () => {
      const sqlLower = sql.toLowerCase();
      if (sqlLower.includes('insert into users')) {
        // Only insert if email not already present (ON CONFLICT DO NOTHING)
        const email = String(bindings[1]).toLowerCase();
        if (!rows.users.find((u) => u.email === email)) {
          rows.users.push({
            id: bindings[0], email, password_hash: bindings[2],
            plan_tier: 'free', role: 'user',
          });
        }
      }
      if (sqlLower.includes('insert into sessions')) {
        rows.sessions.push({
          id: bindings[0], user_id: bindings[1], access_token: bindings[2],
          refresh_token: bindings[3], expires_at: bindings[4],
          ip_address: bindings[5], user_agent: bindings[6],
          revoked_at: null,
        });
      }
      if (sqlLower.includes('update sessions set access_token')) {
        const s = rows.sessions.find((s) => s.id === bindings[1]);
        if (s) s.access_token = bindings[0] as string;
      }
      if (sqlLower.includes('update sessions set revoked_at')) {
        rows.sessions
          .filter((s) => s.user_id === bindings[1] && !s.revoked_at)
          .forEach((s) => { s.revoked_at = bindings[0]; });
      }
      // audit_log inserts are silently consumed
    },
    // Accept multiple bind args (mirrors real D1 API)
    bind: (...args: unknown[]) => mockStmt(sql, [...bindings, ...args]),
  });

  return {
    prepare: (sql: string) => mockStmt(sql, []),
    _rows: rows,
  };
}

function makeKV() {
  const store: Map<string, string> = new Map();
  return {
    get:    async (k: string)             => store.get(k) ?? null,
    put:    async (k: string, v: string)  => { store.set(k, v); },
    delete: async (k: string)             => { store.delete(k); },
  };
}

// ── Build app ─────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-for-vitest';

function buildApp(db = makeD1(), kv = makeKV()) {
  const app = new Hono<{
    Bindings: { DB: any; CACHE: any; JWT_SECRET: string };
  }>();

  // Inject mock bindings
  app.use('*', async (c, next) => {
    (c.env as any) = { DB: db, CACHE: kv, JWT_SECRET };
    await next();
  });

  app.route('/auth', authRoutes);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe('POST /auth/signup', () => {
  it('creates a user and returns userId', async () => {
    const app = buildApp();
    const res  = await app.fetch(req('POST', '/auth/signup', { email: 'user@test.com', password: 'securePass1' }));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.userId).toBeTruthy();
  });

  it('returns 400 when email is missing', async () => {
    const app = buildApp();
    const res  = await app.fetch(req('POST', '/auth/signup', { password: 'securePass1' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is too short', async () => {
    const app = buildApp();
    const res  = await app.fetch(req('POST', '/auth/signup', { email: 'a@b.com', password: '1234' }));
    expect(res.status).toBe(400);
  });

  it('returns 409 for duplicate email', async () => {
    const db  = makeD1();
    const app = buildApp(db);
    await app.fetch(req('POST', '/auth/signup', { email: 'dup@test.com', password: 'securePass1' }));
    const res = await app.fetch(req('POST', '/auth/signup', { email: 'dup@test.com', password: 'securePass1' }));
    expect(res.status).toBe(409);
  });
});

describe('POST /auth/signin', () => {
  it('returns access + refresh tokens for valid credentials', async () => {
    const db  = makeD1();
    const app = buildApp(db);

    // Create user first
    await app.fetch(req('POST', '/auth/signup', { email: 'test@banproof.me', password: 'goodPass99' }));

    const res  = await app.fetch(req('POST', '/auth/signin', { email: 'test@banproof.me', password: 'goodPass99' }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.expiresIn).toBe(3600);
    expect(body.user.email).toBe('test@banproof.me');
  });

  it('returns 401 for unknown email', async () => {
    const app = buildApp();
    const res  = await app.fetch(req('POST', '/auth/signin', { email: 'ghost@test.com', password: 'pass123' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong password', async () => {
    const db  = makeD1();
    const app = buildApp(db);
    await app.fetch(req('POST', '/auth/signup', { email: 'user@test.com', password: 'rightPass1' }));
    const res = await app.fetch(req('POST', '/auth/signin', { email: 'user@test.com', password: 'wrongPass9' }));
    expect(res.status).toBe(401);
  });

  it('normalises email to lowercase before lookup', async () => {
    const db  = makeD1();
    const app = buildApp(db);
    await app.fetch(req('POST', '/auth/signup', { email: 'User@Test.COM', password: 'securePass1' }));
    const res = await app.fetch(req('POST', '/auth/signin', { email: 'user@test.com', password: 'securePass1' }));
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/refresh', () => {
  it('returns a new access token for a valid refresh token', async () => {
    const db  = makeD1();
    const app = buildApp(db);

    await app.fetch(req('POST', '/auth/signup', { email: 'r@test.com', password: 'securePass1' }));
    const signin  = await app.fetch(req('POST', '/auth/signin', { email: 'r@test.com', password: 'securePass1' }));
    const { refreshToken } = await signin.json() as any;

    const res  = await app.fetch(req('POST', '/auth/refresh', { refreshToken }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accessToken).toBeTruthy();
  });

  it('returns 400 when refreshToken is missing', async () => {
    const app = buildApp();
    const res  = await app.fetch(req('POST', '/auth/refresh', {}));
    expect(res.status).toBe(400);
  });

  it('returns 401 for an unknown refresh token', async () => {
    const app = buildApp();
    const res  = await app.fetch(req('POST', '/auth/refresh', { refreshToken: 'unknown-token' }));
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes all sessions and returns ok', async () => {
    const db  = makeD1();
    const app = buildApp(db);

    await app.fetch(req('POST', '/auth/signup', { email: 'lo@test.com', password: 'securePass1' }));
    const signin = await app.fetch(req('POST', '/auth/signin', { email: 'lo@test.com', password: 'securePass1' }));
    const { accessToken } = await signin.json() as any;

    const res = await app.fetch(req('POST', '/auth/logout', undefined, {
      Authorization: `Bearer ${accessToken}`,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);

    // Session should now be revoked
    const session = db._rows.sessions[0];
    expect(session.revoked_at).toBeTruthy();
  });

  it('returns 401 when no Authorization header', async () => {
    const app = buildApp();
    const res  = await app.fetch(req('POST', '/auth/logout'));
    expect(res.status).toBe(401);
  });
});
