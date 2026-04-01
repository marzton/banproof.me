-- Users & Subscriptions
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    plan_tier TEXT DEFAULT 'free', -- 'free', 'pro', 'agency'
    stripe_customer_id TEXT,
    discord_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Audit Log for "Banproof" Forensics
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
