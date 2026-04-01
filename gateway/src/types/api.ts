// ============================================================
// API Types — shared across middleware, routes, and engine
// ============================================================

// ── Auth ─────────────────────────────────────────────────────

export type PlanTier = 'free' | 'pro' | 'agency';
export type UserRole  = 'user' | 'admin' | 'sudo';

export interface AuthContext {
  userId: string;
  email:  string;
  role:   UserRole;
  tier:   PlanTier;
}

export interface JwtPayload {
  sub:   string;  // userId
  email: string;
  role:  UserRole;
  tier:  PlanTier;
  iat:   number;
  exp:   number;
}

// ── Engine / Workflow ─────────────────────────────────────────

export type SentimentLabel = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface SentimentResult {
  label:      SentimentLabel;
  score:      number;  // 0.0 – 1.0
  confidence: number;  // 0.0 – 1.0
}

export interface BookmakerOdds {
  bookmaker: string;
  price:     number;  // American odds (negative = favourite)
  spread:    number;  // spread in points (0 = best value)
}

export interface BestPrice {
  bookmaker: string;
  price:     number;
  value:     'EV+' | 'EV-' | 'NEUTRAL';
}

export interface OddsResult {
  bookmakers: BookmakerOdds[];
  bestPrice:  BestPrice;
}

export interface AgencyAnalytics {
  sharp_public_split: { sharp_price: number; public_price: number };
  ev_plus_threshold:  number;
  confidence_multiplier: number;
  recommendation:     'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL';
}

// ── Audit ────────────────────────────────────────────────────

export interface AuditEntry {
  user_id:  string;
  action:   string;
  metadata: Record<string, unknown>;
}

export interface AdminAuditEntry {
  admin_id:       string;
  action:         'tier_change' | 'inquiry_quoted' | 'user_created';
  target_user_id: string;
  metadata:       Record<string, unknown>;
  ip_address:     string;
}
// Banproof API — Shared TypeScript types
// ============================================================

export interface SentimentResult {
  score: number;
  label: 'BULLISH' | 'BEARISH';
  confidence: number;
  source: 'MOCK_HF' | 'REAL_HF';
}

export interface Bookmaker {
  name: string;
  price: number;
  spread: number;
  value?: 'EV+' | 'EV-' | 'FAIR';
}

export interface OddsResult {
  bookmakers: Bookmaker[];
  best_price: { bookmaker: string; price: number };
  source: 'MOCK_ODDS' | 'REAL_ODDS';
}

export interface WorkflowPayload {
  query: string;
  userId: string;
  useMock?: boolean;
}

export type AuditAction =
  | 'AI_ANALYSIS'
  | 'RATE_LIMIT_HIT'
  | 'WORKFLOW_START'
  | 'WORKFLOW_COMPLETE'
  | 'WORKFLOW_ERROR'
  | 'DISCORD_NOTIFY';
