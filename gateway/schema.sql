-- ============================================================
-- banproof-core Gateway — D1 Schema (bp-core-prod)
-- Apply: wrangler d1 execute bp-core-prod --file=schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id                 TEXT     PRIMARY KEY,
    email              TEXT     UNIQUE NOT NULL,
    plan_tier          TEXT     DEFAULT 'free',
    stripe_customer_id TEXT,
    discord_id         TEXT,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER  PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT     NOT NULL REFERENCES users(id),
    action     TEXT     NOT NULL,
    metadata   TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_id    ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
