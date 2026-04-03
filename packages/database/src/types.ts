// ============================================================
// @goldshore/database — Platform TypeScript Interfaces
// Shared across all Gold Shore services.
// ============================================================

// ── Enumerations ──────────────────────────────────────────────

export type UserRole    = 'user' | 'admin' | 'sudo';
export type PlanTier    = 'free' | 'pro' | 'agency';
export type SubStatus   = 'active' | 'canceled' | 'past_due' | 'trialing';

export type SignalType  = 'SPORTS' | 'INVENTORY' | 'POL_QUANT' | 'RISK_RADAR';

export type ProjectType =
  | 'AI_INFRA'
  | 'SYSTEM_AUDIT'
  | 'BANPROOF_PRO'
  | 'RISK_RADAR'
  | 'POL_QUANT';

export type InquiryStatus = 'pending' | 'quoted' | 'closed';

export type AdminAction =
  | 'tier_change'
  | 'inquiry_quoted'
  | 'user_created'
  | 'log_pruned';

// ── Platform Entities ─────────────────────────────────────────

/**
 * A Gold Shore platform user.
 * Replaces BanproofUser — works across all services.
 */
export interface PlatformUser {
  id:            string;
  email:         string;
  password_hash: string;
  role:          UserRole;
  plan_tier:     PlanTier;
  /**
   * JSON blob: flexible per-service user settings.
   * Keys: discord_id?, stripe_customer_id?, prefs?, migrated_from?
   * (Replaces the old user_settings column.)
   */
  metadata:      string | null;
  created_at:    string;
}

/**
 * Session row — JWT access + refresh tokens with revocation.
 */
export interface PlatformSession {
  id:            string;
  user_id:       string;
  access_token:  string;
  refresh_token: string;
  expires_at:    string;
  revoked_at:    string | null;
  ip_address:    string | null;
  user_agent:    string | null;
  created_at:    string;
}

/**
 * Stripe-backed subscription record.
 */
export interface PlatformSubscription {
  id:                     string;
  user_id:                string;
  stripe_subscription_id: string | null;
  plan_tier:              PlanTier;
  status:                 SubStatus;
  current_period_start:   string | null;
  current_period_end:     string | null;
  auto_renew:             number;
  created_at:             string;
}

// ── Gold Shore Agency Entities ────────────────────────────────

/**
 * A Gold Shore Agency inquiry.
 * Supports all service types via project_type discriminant.
 */
export interface Inquiry {
  id:           string;
  user_id:      string | null;
  company_name: string | null;
  email:        string;
  project_type: ProjectType;
  status:       InquiryStatus;
  /**
   * JSON blob: request details, quote text, admin notes.
   */
  metadata:     string | null;
  created_at:   string;
}

// ── Banproof Service Entities ─────────────────────────────────

/**
 * A Banproof signal result.
 * Banproof-specific — stored in the signals table, not audit_log.
 */
export interface Signal {
  id:         string;
  user_id:    string;
  type:       SignalType;
  score:      number | null;
  /**
   * JSON blob: raw HuggingFace + Odds API responses,
   * sentiment label, best price, analytics output.
   */
  metadata:   string | null;
  created_at: string;
}

// ── Infrastructure Entities ───────────────────────────────────

/**
 * Global platform audit log.
 * Non-deletable by user/admin roles — only sudo may prune.
 */
export interface AuditLogEntry {
  id:         number;
  user_id:    string | null;
  action:     string;
  metadata:   string | null;
  ip_address: string | null;
  created_at: string;
}

/**
 * Admin-only action trail.
 */
export interface AdminAuditEntry {
  id:             number;
  admin_id:       string;
  action:         AdminAction;
  target_user_id: string | null;
  metadata:       string | null;
  ip_address:     string | null;
  created_at:     string;
}

// ── Convenience: slim public user (safe to expose in JWTs / APIs) ─

export type PublicUser = Pick<PlatformUser, 'id' | 'email' | 'role' | 'plan_tier'>;
