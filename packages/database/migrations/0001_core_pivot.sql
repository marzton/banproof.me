-- ============================================================
-- Gold Shore Core — Platform Schema Migration
-- Database: gs-platform-prod (D1)
-- Apply: wrangler d1 execute gs-platform-prod \
--          --file=packages/database/migrations/0001_core_pivot.sql
-- ============================================================
-- This migration pivots from a single-app Banproof schema to
-- the Gold Shore shared kernel used by all platform services.
-- Key changes:
--   • CHECK constraints on every enum column (prevent schema drift)
--   • users.metadata JSON column replaces per-app user_settings
--   • signals table replaces scattered audit_log signal entries
--   • inquiries table supports all Gold Shore Agency project types
--   • audit_log centralised; non-deletable except by sudo role
-- ============================================================

-- ── 1. PLATFORM: Users — global roles + JSON metadata ─────────

CREATE TABLE IF NOT EXISTS users (
    id            TEXT     PRIMARY KEY,
    email         TEXT     UNIQUE NOT NULL,
    password_hash TEXT     NOT NULL,
    role          TEXT     NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'admin', 'sudo')),
    plan_tier     TEXT     NOT NULL DEFAULT 'free'
        CHECK (plan_tier IN ('free', 'pro', 'agency')),
    metadata      TEXT,    -- JSON: discord_id, stripe_customer_id, prefs, etc.
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ── Migration helper: populate metadata from existing columns ─
-- Run once against existing data:
--   UPDATE users
--     SET metadata = json_object('migrated_at', CURRENT_TIMESTAMP)
--     WHERE metadata IS NULL;

-- ── 2. PLATFORM: Sessions — JWT-based with revocation ─────────

CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT     PRIMARY KEY,
    user_id       TEXT     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    access_token  TEXT     NOT NULL,
    refresh_token TEXT     NOT NULL UNIQUE,
    expires_at    DATETIME NOT NULL,
    revoked_at    DATETIME,
    ip_address    TEXT,
    user_agent    TEXT,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id       ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions (refresh_token);

-- ── 3. PLATFORM: Subscriptions ────────────────────────────────

CREATE TABLE IF NOT EXISTS subscriptions (
    id                     TEXT     PRIMARY KEY,
    user_id                TEXT     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    stripe_subscription_id TEXT,
    plan_tier              TEXT     NOT NULL DEFAULT 'free'
        CHECK (plan_tier IN ('free', 'pro', 'agency')),
    status                 TEXT     NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'canceled', 'past_due', 'trialing')),
    current_period_start   DATETIME,
    current_period_end     DATETIME,
    auto_renew             INTEGER  NOT NULL DEFAULT 1,
    created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status  ON subscriptions (status);

-- ── 4. GOLD SHORE AGENCY: Unified Inquiry System ──────────────

CREATE TABLE IF NOT EXISTS inquiries (
    id           TEXT     PRIMARY KEY,
    user_id      TEXT     REFERENCES users (id) ON DELETE SET NULL,
    company_name TEXT,
    email        TEXT     NOT NULL,
    project_type TEXT     NOT NULL DEFAULT 'BANPROOF_PRO'
        CHECK (project_type IN ('AI_INFRA', 'SYSTEM_AUDIT', 'BANPROOF_PRO', 'RISK_RADAR', 'POL_QUANT')),
    status       TEXT     NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'quoted', 'closed')),
    metadata     TEXT,    -- JSON: request details, quote text, notes
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries (status);

-- ── 5. BANPROOF SERVICE: Signals ──────────────────────────────
-- Banproof-specific signal results live here, not in audit_log.
-- The gateway engine writes here; the platform kernel stays clean.

CREATE TABLE IF NOT EXISTS signals (
    id         TEXT     PRIMARY KEY,
    user_id    TEXT     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type       TEXT     NOT NULL DEFAULT 'SPORTS'
        CHECK (type IN ('SPORTS', 'INVENTORY', 'POL_QUANT', 'RISK_RADAR')),
    score      REAL,
    metadata   TEXT,    -- JSON: raw HF + Odds API responses, tier used
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_signals_user_id ON signals (user_id);
CREATE INDEX IF NOT EXISTS idx_signals_type    ON signals (type);

-- ── 6. INFRA: Global Audit Trail ──────────────────────────────
-- Non-deletable by standard user/admin roles.
-- Only the sudo role may prune rows (enforced at app layer).

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER  PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT     REFERENCES users (id) ON DELETE SET NULL,
    action     TEXT     NOT NULL,
        -- Platform: 'SIGN_IN' | 'SIGN_OUT' | 'SIGN_UP'
        -- Signals:  'SIGNAL_GEN' | 'SENTIMENT_ONLY' | 'ODDS_ANALYSIS' | 'AGENCY_FULL_ANALYSIS'
        -- Admin:    'ADMIN_EDIT' | 'TIER_CHANGE' | 'INQUIRY_QUOTED'
    metadata   TEXT,    -- JSON
    ip_address TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_id   ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action    ON audit_log (action);

-- ── 7. INFRA: Admin Audit Log ─────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id             INTEGER  PRIMARY KEY AUTOINCREMENT,
    admin_id       TEXT     NOT NULL,
    action         TEXT     NOT NULL
        CHECK (action IN ('tier_change', 'inquiry_quoted', 'user_created', 'log_pruned')),
    target_user_id TEXT,
    metadata       TEXT,
    ip_address     TEXT,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin_id ON admin_audit_log (admin_id);

-- ── Data migration helper ─────────────────────────────────────
-- If migrating from an existing banproof_db, run these statements
-- against the old database and insert the results into gs-platform-prod:
--
-- INSERT INTO users (id, email, password_hash, role, plan_tier, metadata)
--   SELECT id, email, password_hash,
--          CASE WHEN role IS NULL THEN 'user' ELSE role END,
--          COALESCE(plan_tier, 'free'),
--          json_object('migrated_from', 'banproof_db',
--                      'migrated_at', CURRENT_TIMESTAMP)
--   FROM old_banproof_users;
