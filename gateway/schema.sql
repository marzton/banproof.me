-- ============================================================
-- banproof-core Gateway — D1 Schema (bp-core-prod)
-- Apply: wrangler d1 execute bp-core-prod --file=schema.sql
--
-- For the full Gold Shore multi-tenant schema see:
--   packages/database/migrations/0001_core_pivot.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id            TEXT     PRIMARY KEY,          -- crypto.randomUUID()
    email         TEXT     UNIQUE NOT NULL,
    password_hash TEXT     NOT NULL,             -- PBKDF2 (never store plaintext)
    plan_tier     TEXT     NOT NULL DEFAULT 'free'
        CHECK (plan_tier IN ('free', 'pro', 'agency')),
    role          TEXT     NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'admin', 'sudo')),
    metadata      TEXT,    -- JSON: discord_id, stripe_customer_id, prefs
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT     PRIMARY KEY,          -- crypto.randomUUID()
    user_id       TEXT     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    access_token  TEXT     NOT NULL,             -- JWT (short-lived, 1 hour)
    refresh_token TEXT     NOT NULL UNIQUE,      -- UUID (30-day, stored for revocation)
    expires_at    DATETIME NOT NULL,             -- refresh token expiry
    revoked_at    DATETIME,                      -- NULL = active, set on logout
    ip_address    TEXT,
    user_agent    TEXT,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id      ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions (refresh_token);

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
    auto_renew             INTEGER  NOT NULL DEFAULT 1, -- 0 = off, 1 = on
    created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions (user_id);

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id             INTEGER  PRIMARY KEY AUTOINCREMENT,
    admin_id       TEXT     NOT NULL,
    action         TEXT     NOT NULL
        CHECK (action IN ('tier_change', 'inquiry_quoted', 'user_created', 'log_pruned')),
    target_user_id TEXT,
    metadata       TEXT,               -- JSON blob
    ip_address     TEXT,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin_id ON admin_audit_log (admin_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER  PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    user_id    TEXT     NOT NULL REFERENCES users(id),
    action     TEXT     NOT NULL,
    metadata   TEXT,
    ip_address TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log (user_id);

-- Banproof-specific signal results (replaces scattered audit_log signal rows)
CREATE TABLE IF NOT EXISTS signals (
    id         TEXT     PRIMARY KEY,
    user_id    TEXT     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type       TEXT     NOT NULL DEFAULT 'SPORTS'
        CHECK (type IN ('SPORTS', 'INVENTORY', 'POL_QUANT', 'RISK_RADAR')),
    score      REAL,
    metadata   TEXT,    -- JSON: raw HF + Odds API responses
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_signals_user_id ON signals (user_id);

-- Gold Shore Agency inquiries (aligned with Gold Shore project types)
CREATE TABLE IF NOT EXISTS inquiries (
    id           TEXT     PRIMARY KEY,
    user_id      TEXT     REFERENCES users (id) ON DELETE SET NULL,
    company_name TEXT,
    email        TEXT     NOT NULL,
    project_type TEXT     NOT NULL DEFAULT 'BANPROOF_PRO'
        CHECK (project_type IN ('AI_INFRA', 'SYSTEM_AUDIT', 'BANPROOF_PRO', 'RISK_RADAR', 'POL_QUANT')),
    status       TEXT     NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'quoted', 'closed')),
    metadata     TEXT,    -- JSON: request details, quote text, admin notes
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries (status);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id    ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
