// ============================================================
// Admin Routes — dashboard, subscriptions, tier updates, audit
//
// All routes require authMiddleware + requireAdmin.
// Sudo-only routes additionally require requireSudo.
// ============================================================

import { Hono } from 'hono';
import { authMiddleware, requireAdmin, requireSudo } from '../middleware/auth.js';

type Env = {
  DB:         D1Database;
  CACHE:      KVNamespace;
  JWT_SECRET: string;
};

type Variables = {
  auth: import('../types/api.js').AuthContext;
};

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Apply auth + admin guard to all routes ────────────────────
admin.use('*', authMiddleware, requireAdmin);

// ── Helper: log admin action ──────────────────────────────────

async function logAdminAction(
  db: D1Database,
  adminId: string,
  action: string,
  targetUserId: string | null,
  metadata: Record<string, unknown>,
  ip: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO admin_audit_log (admin_id, action, target_user_id, metadata, ip_address)
       VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(adminId, action, targetUserId ?? null, JSON.stringify(metadata), ip)
    .run();
}

// ── GET /admin/dashboard ──────────────────────────────────────

admin.get('/dashboard', async (c) => {
  const [usersRow, subsRow, inquiriesRow, recentInquiries] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as total FROM users').first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM subscriptions WHERE status = 'active'`,
    ).first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM inquiries WHERE status = 'pending'`,
    ).first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT id, company, email, project_type, status, created_at
         FROM inquiries ORDER BY created_at DESC LIMIT 10`,
    ).all<{
      id: string; company: string; email: string;
      project_type: string; status: string; created_at: string;
    }>(),
  ]);

  return c.json({
    stats: {
      total_users:           usersRow?.total          ?? 0,
      active_subscriptions:  subsRow?.total           ?? 0,
      pending_inquiries:     inquiriesRow?.total       ?? 0,
    },
    recent_inquiries: recentInquiries.results,
  });
});

// ── GET /admin/subscriptions ──────────────────────────────────

admin.get('/subscriptions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.plan_tier, s.status, s.current_period_end, s.auto_renew,
            u.id as user_id, u.email
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active'
      ORDER BY s.current_period_end ASC
      LIMIT 100`,
  ).all();

  return c.json(results);
});

// ── POST /admin/users/:userId/tier ────────────────────────────

admin.post('/users/:userId/tier', async (c) => {
  const auth   = c.get('auth');
  const userId = c.req.param('userId');
  const ip     = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? '';
  const { tier } = await c.req.json<{ tier: string }>();

  const allowed = ['free', 'pro', 'agency'];
  if (!allowed.includes(tier)) {
    return c.json({ error: `tier must be one of: ${allowed.join(', ')}` }, 400);
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, plan_tier FROM users WHERE id = ? LIMIT 1',
  ).bind(userId).first<{ id: string; email: string; plan_tier: string }>();

  if (!user) {
    return c.json({ error: 'User not found.' }, 404);
  }

  await c.env.DB.prepare(
    'UPDATE users SET plan_tier = ? WHERE id = ?',
  ).bind(tier, userId).run();

  // Invalidate cached session
  await c.env.CACHE.delete(`session:${userId}`);

  await logAdminAction(
    c.env.DB, auth.userId, 'tier_change', userId,
    { previous_tier: user.plan_tier, new_tier: tier, email: user.email },
    ip,
  );

  return c.json({ ok: true, userId, newTier: tier });
});

// ── POST /admin/inquiries/:inquiryId/quote ────────────────────

admin.post('/inquiries/:inquiryId/quote', async (c) => {
  const auth      = c.get('auth');
  const inquiryId = c.req.param('inquiryId');
  const ip        = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? '';
  const { quote } = await c.req.json<{ quote: string }>();

  if (!quote) {
    return c.json({ error: 'quote is required.' }, 400);
  }

  const inquiry = await c.env.DB.prepare(
    'SELECT id, email, company, status FROM inquiries WHERE id = ? LIMIT 1',
  ).bind(inquiryId).first<{ id: string; email: string; company: string; status: string }>();

  if (!inquiry) {
    return c.json({ error: 'Inquiry not found.' }, 404);
  }

  await c.env.DB.prepare(
    `UPDATE inquiries SET status = 'quoted' WHERE id = ?`,
  ).bind(inquiryId).run();

  await logAdminAction(
    c.env.DB, auth.userId, 'inquiry_quoted', null,
    { inquiry_id: inquiryId, company: inquiry.company, email: inquiry.email, quote },
    ip,
  );

  // Notify via console (Discord/email wired in engine step)
  console.log(`[Admin] Quote sent to ${inquiry.email} for ${inquiry.company}: ${quote}`);

  return c.json({ ok: true, inquiryId, status: 'quoted' });
});

// ── GET /admin/audit-log (sudo only) ─────────────────────────

admin.get('/audit-log', requireSudo, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, admin_id, action, target_user_id, metadata, ip_address, created_at
       FROM admin_audit_log
       ORDER BY created_at DESC
       LIMIT 100`,
  ).all();

  return c.json(results);
});

export default admin;
