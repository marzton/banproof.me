// ============================================================
// @goldshore/db — Platform Schema
// Typed interfaces for all platform tables.
// Property names use camelCase; column names in D1 are snake_case.
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

export interface User {
  id:           string;
  email:        string;
  passwordHash: string;
  role:         UserRole;
  planTier:     PlanTier;
  /** JSON blob: discord_id?, stripe_customer_id?, prefs?, migrated_from? */
  metadata:     string | null;
  createdAt:    string;
}

export interface Session {
  id:           string;
  userId:       string;
  accessToken:  string;
  refreshToken: string;
  expiresAt:    string;
  revokedAt:    string | null;
  ipAddress:    string | null;
  userAgent:    string | null;
  createdAt:    string;
}

export interface Subscription {
  id:                   string;
  userId:               string;
  stripeSubscriptionId: string | null;
  planTier:             PlanTier;
  status:               SubStatus;
  currentPeriodStart:   string | null;
  currentPeriodEnd:     string | null;
  autoRenew:            number;
  createdAt:            string;
}

// ── Gold Shore Agency ─────────────────────────────────────────

/**
 * A Gold Shore Agency inquiry.
 * userId is nullable — inquiries may be submitted by anonymous visitors
 * who have not yet registered a platform account.
 */
export interface Inquiry {
  id:          string;
  userId:      string | null;
  companyName: string | null;
  email:       string;
  projectType: ProjectType;
  status:      InquiryStatus;
  /** JSON blob: request details, quote text, admin notes */
  metadata:    string | null;
  createdAt:   string;
}

// ── Banproof Service ──────────────────────────────────────────

export interface Signal {
  id:        string;
  userId:    string;
  type:      SignalType;
  score:     number | null;
  /** JSON blob: raw HF + Odds API responses, tier used */
  metadata:  string | null;
  createdAt: string;
}

// ── Infrastructure ────────────────────────────────────────────

export interface AuditLogEntry {
  id:        number;
  userId:    string | null;
  action:    string;
  metadata:  string | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface AdminAuditEntry {
  id:           number;
  adminId:      string;
  action:       AdminAction;
  targetUserId: string | null;
  metadata:     string | null;
  ipAddress:    string | null;
  createdAt:    string;
}

// ── Convenience ───────────────────────────────────────────────

export type PublicUser = Pick<User, 'id' | 'email' | 'role' | 'planTier'>;
