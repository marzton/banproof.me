// ============================================================
// Auth Middleware — JWT verification + role guards
//
// Extracts Bearer JWT from Authorization header, verifies
// signature via JWT_SECRET, checks session revocation in D1,
// and attaches AuthContext to the Hono context.
//
// Guards:
//   authMiddleware  — any authenticated user
//   requireAdmin    — role must be 'admin' or 'sudo'
//   requireSudo     — role must be 'sudo'
// ============================================================

import { MiddlewareHandler } from 'hono';
import { verify }            from 'hono/jwt';
import type { AuthContext, JwtPayload } from '../types/api.js';

// ── Bindings needed by this middleware ────────────────────────
type AuthEnv = {
  DB:         D1Database;
  CACHE:      KVNamespace;
  JWT_SECRET: string;
};

type AuthVariables = {
  auth: AuthContext;
};

// ── authMiddleware ────────────────────────────────────────────

export const authMiddleware: MiddlewareHandler<{
  Bindings:  AuthEnv;
  Variables: AuthVariables;
}> = async (c, next) => {
  const authHeader = c.req.header('Authorization') ?? '';
  const token      = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  let payload: JwtPayload;
  try {
    payload = (await verify(token, c.env.JWT_SECRET, 'HS256')) as unknown as JwtPayload;
  } catch {
    return c.json({ error: 'Invalid or expired token.' }, 401);
  }

  // Check if session has been revoked in D1
  const revoked = await c.env.DB.prepare(
    `SELECT revoked_at FROM sessions
      WHERE access_token = ? AND user_id = ?
      LIMIT 1`,
  )
    .bind(token, payload.sub)
    .first<{ revoked_at: string | null }>();

  if (!revoked) {
    return c.json({ error: 'Session not found. Please sign in again.' }, 401);
  }

  if (revoked.revoked_at !== null) {
    return c.json({ error: 'Session has been revoked. Please sign in again.' }, 401);
  }

  c.set('auth', {
    userId: payload.sub,
    email:  payload.email,
    role:   payload.role,
    tier:   payload.tier,
  });

  await next();
};

// ── requireAdmin ──────────────────────────────────────────────

export const requireAdmin: MiddlewareHandler<{
  Bindings:  AuthEnv;
  Variables: AuthVariables;
}> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth || (auth.role !== 'admin' && auth.role !== 'sudo')) {
    return c.json({ error: 'Admin access required.' }, 403);
  }
  await next();
};

// ── requireSudo ───────────────────────────────────────────────

export const requireSudo: MiddlewareHandler<{
  Bindings:  AuthEnv;
  Variables: AuthVariables;
}> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth || auth.role !== 'sudo') {
    return c.json({ error: 'Sudo access required.' }, 403);
  }
  await next();
};
