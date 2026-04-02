// ============================================================
// Auth Routes — signup, signin, refresh, logout
//
// POST /auth/signup   — create account, return userId
// POST /auth/signin   — verify credentials, return JWT pair
// POST /auth/refresh  — exchange refresh token for new access token
// POST /auth/logout   — revoke all sessions for user
// ============================================================

import { Hono }  from 'hono';
import { sign }  from 'hono/jwt';
import type { JwtPayload, PlanTier, UserRole } from '../types/api.js';

type Env = {
  DB:         D1Database;
  CACHE:      KVNamespace;
  JWT_SECRET: string;
};

type Variables = {
  auth: import('../types/api.js').AuthContext;
};

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Password hashing (PBKDF2-SHA256, 100 000 iterations) ─────

const enc = new TextEncoder();

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );

  const toHex = (arr: ArrayBuffer) =>
    Array.from(new Uint8Array(arr))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  return `pbkdf2:${toHex(salt.buffer)}:${toHex(bits)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;

  const saltBytes = Uint8Array.from(
    (parts[1].match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)),
  );

  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );

  const candidate = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return candidate === parts[2];
}

// ── Token helpers ─────────────────────────────────────────────

const ACCESS_TOKEN_TTL  = 3600;        // 1 hour (seconds)
const REFRESH_TOKEN_DAYS = 30;

async function createAccessToken(
  userId: string,
  email: string,
  role: UserRole,
  tier: PlanTier,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub:   userId,
    email,
    role,
    tier,
    iat:   now,
    exp:   now + ACCESS_TOKEN_TTL,
  };
  return sign(payload, secret);
}

// ── POST /auth/signup ─────────────────────────────────────────

auth.post('/signup', async (c) => {
  const { email, password } = await c.req.json<{
    email: string;
    password: string;
  }>();

  if (!email || !password) {
    return c.json({ error: 'email and password are required.' }, 400);
  }

  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters.' }, 400);
  }

  // Check for duplicate email
  const existing = await c.env.DB.prepare(
    'SELECT id FROM users WHERE email = ? LIMIT 1',
  ).bind(email.toLowerCase().trim()).first<{ id: string }>();

  if (existing) {
    return c.json({ error: 'An account with this email already exists.' }, 409);
  }

  const id           = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const ip           = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? '';

  await c.env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, plan_tier, role)
       VALUES (?, ?, ?, 'free', 'user')`,
  ).bind(id, email.toLowerCase().trim(), passwordHash).run();

  // Audit log
  await c.env.DB.prepare(
    `INSERT INTO audit_log (user_id, action, metadata)
       VALUES (?, 'user_created', ?)`,
  ).bind(id, JSON.stringify({ email, ip })).run();

  console.log(`[Auth] signup: ${email} (${id}) from ${ip}`);

  return c.json({ userId: id }, 201);
});

// ── POST /auth/signin ─────────────────────────────────────────

auth.post('/signin', async (c) => {
  const { email, password } = await c.req.json<{
    email: string;
    password: string;
  }>();

  if (!email || !password) {
    return c.json({ error: 'email and password are required.' }, 400);
  }

  const ip        = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? '';
  const userAgent = c.req.header('User-Agent') ?? '';

  const user = await c.env.DB.prepare(
    `SELECT id, email, password_hash, plan_tier, role
       FROM users WHERE email = ? LIMIT 1`,
  ).bind(email.toLowerCase().trim()).first<{
    id: string; email: string; password_hash: string;
    plan_tier: PlanTier; role: UserRole;
  }>();

  if (!user) {
    // Audit failed attempt
    await c.env.DB.prepare(
      `INSERT INTO audit_log (action, metadata)
         VALUES ('signin_failed', ?)`,
    ).bind(JSON.stringify({ email, reason: 'user_not_found', ip })).run();

    return c.json({ error: 'Invalid email or password.' }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);

  if (!valid) {
    await c.env.DB.prepare(
      `INSERT INTO audit_log (user_id, action, metadata)
         VALUES (?, 'signin_failed', ?)`,
    ).bind(user.id, JSON.stringify({ reason: 'wrong_password', ip })).run();

    return c.json({ error: 'Invalid email or password.' }, 401);
  }

  // Generate tokens
  const accessToken  = await createAccessToken(user.id, user.email, user.role, user.plan_tier, c.env.JWT_SECRET);
  const refreshToken = crypto.randomUUID();
  const sessionId    = crypto.randomUUID();

  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86_400_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, access_token, refresh_token, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(sessionId, user.id, accessToken, refreshToken, expiresAt, ip, userAgent).run();

  // Audit successful signin
  await c.env.DB.prepare(
    `INSERT INTO audit_log (user_id, action, metadata)
       VALUES (?, 'signin_success', ?)`,
  ).bind(user.id, JSON.stringify({ ip, userAgent })).run();

  console.log(`[Auth] signin: ${user.email} from ${ip}`);

  return c.json({
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL,
    user: {
      id:    user.id,
      email: user.email,
      role:  user.role,
      tier:  user.plan_tier,
    },
  });
});

// ── POST /auth/refresh ────────────────────────────────────────

auth.post('/refresh', async (c) => {
  const { refreshToken } = await c.req.json<{ refreshToken: string }>();

  if (!refreshToken) {
    return c.json({ error: 'refreshToken is required.' }, 400);
  }

  const session = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.revoked_at, s.expires_at,
            u.email, u.plan_tier, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token = ?
      LIMIT 1`,
  ).bind(refreshToken).first<{
    id: string; user_id: string; revoked_at: string | null;
    expires_at: string; email: string;
    plan_tier: PlanTier; role: UserRole;
  }>();

  if (!session) {
    return c.json({ error: 'Invalid refresh token.' }, 401);
  }

  if (session.revoked_at !== null) {
    return c.json({ error: 'Session has been revoked.' }, 401);
  }

  if (new Date(session.expires_at) < new Date()) {
    return c.json({ error: 'Refresh token has expired. Please sign in again.' }, 401);
  }

  const newAccessToken = await createAccessToken(
    session.user_id, session.email, session.role, session.plan_tier, c.env.JWT_SECRET,
  );

  // Update the stored access token for the session
  await c.env.DB.prepare(
    `UPDATE sessions SET access_token = ? WHERE id = ?`,
  ).bind(newAccessToken, session.id).run();

  return c.json({ accessToken: newAccessToken, expiresIn: ACCESS_TOKEN_TTL });
});

// ── POST /auth/logout ─────────────────────────────────────────

auth.post('/logout', async (c) => {
  const authHeader = c.req.header('Authorization') ?? '';
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? '';

  // Revoke all sessions for this user (find user from any active session)
  const session = await c.env.DB.prepare(
    `SELECT user_id FROM sessions WHERE access_token = ? LIMIT 1`,
  ).bind(token).first<{ user_id: string }>();

  if (!session) {
    return c.json({ error: 'No active session found.' }, 401);
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  await c.env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(now, session.user_id).run();

  // Audit logout
  await c.env.DB.prepare(
    `INSERT INTO audit_log (user_id, action, metadata)
       VALUES (?, 'logout', ?)`,
  ).bind(session.user_id, JSON.stringify({ ip })).run();

  console.log(`[Auth] logout: userId=${session.user_id} from ${ip}`);

  return c.json({ ok: true, message: 'All sessions revoked.' });
});

export default auth;
