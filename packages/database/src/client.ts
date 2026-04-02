// ============================================================
// @goldshore/database — D1 Client Helpers
// Typed query helpers for the Gold Shore platform tables.
// All functions receive a D1Database binding — no global state.
// ============================================================

import type {
  PlatformUser,
  PlatformSession,
  PlatformSubscription,
  Inquiry,
  Signal,
  AuditLogEntry,
  AdminAuditEntry,
  PublicUser,
  PlanTier,
  UserRole,
  AdminAction,
  InquiryStatus,
} from './types.js';

// ── Users ─────────────────────────────────────────────────────

export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<PlatformUser | null> {
  return db
    .prepare('SELECT * FROM users WHERE email = ? LIMIT 1')
    .bind(email.toLowerCase().trim())
    .first<PlatformUser>();
}

export async function getUserById(
  db: D1Database,
  id: string,
): Promise<PlatformUser | null> {
  return db
    .prepare('SELECT * FROM users WHERE id = ? LIMIT 1')
    .bind(id)
    .first<PlatformUser>();
}

export async function createUser(
  db: D1Database,
  params: { id: string; email: string; passwordHash: string; role?: UserRole; planTier?: PlanTier },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, plan_tier)
         VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.email.toLowerCase().trim(),
      params.passwordHash,
      params.role    ?? 'user',
      params.planTier ?? 'free',
    )
    .run();
}

export async function updateUserTier(
  db: D1Database,
  userId: string,
  tier: PlanTier,
): Promise<void> {
  await db
    .prepare('UPDATE users SET plan_tier = ? WHERE id = ?')
    .bind(tier, userId)
    .run();
}

export async function listUsers(
  db: D1Database,
  limit = 100,
): Promise<PublicUser[]> {
  const { results } = await db
    .prepare(
      `SELECT id, email, role, plan_tier
         FROM users ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<PublicUser>();
  return results;
}

// ── Sessions ──────────────────────────────────────────────────

export async function createSession(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    ipAddress?: string;
    userAgent?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions
         (id, user_id, access_token, refresh_token, expires_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.userId,
      params.accessToken,
      params.refreshToken,
      params.expiresAt,
      params.ipAddress ?? null,
      params.userAgent ?? null,
    )
    .run();
}

export async function getSessionByAccessToken(
  db: D1Database,
  accessToken: string,
  userId: string,
): Promise<Pick<PlatformSession, 'revoked_at'> | null> {
  return db
    .prepare(
      `SELECT revoked_at FROM sessions
         WHERE access_token = ? AND user_id = ? LIMIT 1`,
    )
    .bind(accessToken, userId)
    .first<Pick<PlatformSession, 'revoked_at'>>();
}

export async function getSessionByRefreshToken(
  db: D1Database,
  refreshToken: string,
): Promise<(PlatformSession & Pick<PlatformUser, 'email' | 'plan_tier' | 'role'>) | null> {
  return db
    .prepare(
      `SELECT s.*, u.email, u.plan_tier, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token = ? LIMIT 1`,
    )
    .bind(refreshToken)
    .first<PlatformSession & Pick<PlatformUser, 'email' | 'plan_tier' | 'role'>>();
}

export async function revokeUserSessions(
  db: D1Database,
  userId: string,
  revokedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sessions SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(revokedAt, userId)
    .run();
}

export async function updateSessionAccessToken(
  db: D1Database,
  sessionId: string,
  newAccessToken: string,
): Promise<void> {
  await db
    .prepare('UPDATE sessions SET access_token = ? WHERE id = ?')
    .bind(newAccessToken, sessionId)
    .run();
}

// ── Signals (Banproof service) ────────────────────────────────

export async function createSignal(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    type: Signal['type'];
    score?: number;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO signals (id, user_id, type, score, metadata)
         VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.userId,
      params.type,
      params.score ?? null,
      JSON.stringify(params.metadata),
    )
    .run();
}

export async function getSignalsByUser(
  db: D1Database,
  userId: string,
  limit = 50,
): Promise<Signal[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM signals WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<Signal>();
  return results;
}

// ── Inquiries ─────────────────────────────────────────────────

export async function createInquiry(
  db: D1Database,
  params: {
    id: string;
    userId?: string;
    companyName?: string;
    email: string;
    projectType: Inquiry['project_type'];
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO inquiries (id, user_id, company_name, email, project_type, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.userId ?? null,
      params.companyName ?? null,
      params.email,
      params.projectType,
      params.metadata ? JSON.stringify(params.metadata) : null,
    )
    .run();
}

export async function updateInquiryStatus(
  db: D1Database,
  inquiryId: string,
  status: InquiryStatus,
): Promise<void> {
  await db
    .prepare('UPDATE inquiries SET status = ? WHERE id = ?')
    .bind(status, inquiryId)
    .run();
}

export async function getInquiry(
  db: D1Database,
  inquiryId: string,
): Promise<Inquiry | null> {
  return db
    .prepare('SELECT * FROM inquiries WHERE id = ? LIMIT 1')
    .bind(inquiryId)
    .first<Inquiry>();
}

// ── Audit Log ─────────────────────────────────────────────────

export async function writeAuditLog(
  db: D1Database,
  params: {
    userId?: string;
    action: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (user_id, action, metadata, ip_address)
         VALUES (?, ?, ?, ?)`,
    )
    .bind(
      params.userId ?? null,
      params.action,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.ipAddress ?? null,
    )
    .run();
}

/**
 * Prune audit log entries older than the given date.
 * ONLY callable by the sudo role — enforce at the route layer.
 */
export async function pruneAuditLog(
  db: D1Database,
  beforeDate: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM audit_log WHERE created_at < ?')
    .bind(beforeDate)
    .run();
}

// ── Admin Audit Log ───────────────────────────────────────────

export async function writeAdminAuditLog(
  db: D1Database,
  params: {
    adminId: string;
    action: AdminAction;
    targetUserId?: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_audit_log
         (admin_id, action, target_user_id, metadata, ip_address)
         VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      params.adminId,
      params.action,
      params.targetUserId ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.ipAddress ?? null,
    )
    .run();
}

export async function getAdminAuditLog(
  db: D1Database,
  limit = 100,
): Promise<AdminAuditEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM admin_audit_log
         ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<AdminAuditEntry>();
  return results;
}

// ── Dashboard stats ───────────────────────────────────────────

export async function getDashboardStats(db: D1Database): Promise<{
  total_users:          number;
  active_subscriptions: number;
  pending_inquiries:    number;
}> {
  const [users, subs, inquiries] = await Promise.all([
    db.prepare('SELECT COUNT(*) as n FROM users').first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) as n FROM subscriptions WHERE status = 'active'`).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) as n FROM inquiries WHERE status = 'pending'`).first<{ n: number }>(),
  ]);

  return {
    total_users:          users?.n          ?? 0,
    active_subscriptions: subs?.n           ?? 0,
    pending_inquiries:    inquiries?.n       ?? 0,
  };
}
