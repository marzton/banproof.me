-- ============================================================
-- Gold Shore Core — Platform Tables Migration
-- Database: gs-platform-prod (D1)
-- Apply: wrangler d1 execute gs-platform-prod \
--          --file=packages/db/migrations/d1/0001_platform_tables.sql
-- ============================================================

-- ── 1. PLATFORM: Users ────────────────────────────────────────

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

-- ── 2. PLATFORM: Sessions ─────────────────────────────────────

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

-- ── 4. GOLD SHORE AGENCY: Inquiries ───────────────────────────
-- user_id is nullable: inquiries may be submitted by anonymous visitors.

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

CREATE INDEX IF NOT EXISTS idx_inquiries_user_id ON inquiries (user_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_status  ON inquiries (status);

-- ── 5. BANPROOF: Signals ──────────────────────────────────────

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

-- ── 6. INFRA: Global Audit Log ────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER  PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT     REFERENCES users (id) ON DELETE SET NULL,
    action     TEXT     NOT NULL,
    metadata   TEXT,    -- JSON
    ip_address TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action  ON audit_log (action);

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
