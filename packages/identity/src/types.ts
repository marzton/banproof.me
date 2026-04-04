// ============================================================
// @goldshore/identity — Shared identity types
// Source of truth for User, tier, and env shapes used across
// every worker in the banproof.me monorepo.
// ============================================================

export type PlanTier           = 'free' | 'pro' | 'admin';
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due';

export interface User {
  id:                  string;
  email:               string;
  stripe_customer_id:  string | null;
  plan_tier:           PlanTier;
  subscription_status: SubscriptionStatus;
  created_at:          string;
  updated_at:          string;
}

// Minimum Cloudflare bindings required by the auth middleware.
// Extend this interface in each worker's own Env/Bindings type.
export interface IdentityEnv {
  DB:    D1Database;
  CACHE: KVNamespace;
}

// Hono context variables populated by authMiddleware.
export type IdentityVariables = {
  user: Pick<User, 'id' | 'email' | 'plan_tier' | 'subscription_status'>;
};
