// ============================================================
// Cloudflare Worker Env — all bindings + secrets in one place
// ============================================================
// This file is the source of truth for what bindings must exist
// in wrangler.toml and what secrets must be uploaded.
// ============================================================

export interface Env {
  // ── D1 Database (binding: DB) ─────────────────────────────
  DB: D1Database;

  // ── KV Namespaces ─────────────────────────────────────────
  CACHE:         KVNamespace; // session / subscription cache
  INFRA_SECRETS: KVNamespace; // GH_PAT, CF_API_TOKEN, etc.

  // ── Cloudflare AI (binding: AI) ───────────────────────────
  AI: Ai;

  // ── Email Workers (binding: MAILER) ───────────────────────
  MAILER: SendEmail;

  // ── Non-secret vars (set in [vars]) ───────────────────────
  TURNSTILE_SITE_KEY: string; // public Turnstile site key
  ADMIN_EMAIL:        string; // admin@banproof.me
  ENVIRONMENT:        string; // "production" | "development"

  // ── Secrets (uploaded via `wrangler secret put`) ──────────
  TURNSTILE_SECRET_KEY:  string; // Cloudflare Turnstile secret
  STRIPE_SECRET_KEY:     string; // sk_live_...
  STRIPE_WEBHOOK_SECRET: string; // whsec_...
  STRIPE_PRICE_ID_PRO:   string; // price_...
  MAILCHANNELS_API_KEY:  string; // MailChannels outbound email
  CF_API_TOKEN:          string; // Cloudflare API token
  GH_PAT:                string; // GitHub fine-grained PAT
}

// ── Domain types ─────────────────────────────────────────────

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

export interface CmsContent {
  id:         number;
  slug:       string;
  title:      string;
  body:       string;
  category:   string;
  published:  number;
  updated_at: string;
}

// ── Hono context variable types ───────────────────────────────

export type Variables = {
  user: Pick<User, 'id' | 'email' | 'plan_tier' | 'subscription_status'>;
};
