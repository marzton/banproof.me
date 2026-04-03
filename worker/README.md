# banproof-core — Gatekeeper Worker

> **⚠️ DEPRECATED — do not deploy.**
> This worker (`banproof-core-legacy`) has been superseded by **`gateway/`**
> (`banproof-core`), which owns the `banproof.me/api/*` route and provides the
> canonical Cloudflare Workflows + JWT-based API engine.
>
> This directory is preserved as a reference for the session-cookie + Turnstile
> auth pattern and the Stripe webhook handler.  Shared types and auth middleware
> have been extracted to [`packages/identity`](../packages/identity).

Full-stack Cloudflare Worker that sits in front of every `banproof.me/api/*`
request.  It handles bot protection (Turnstile), subscription gating (Stripe →
D1), session caching (KV), AI inference, and outbound email.

---

## Architecture

```
browser / Discord bot
       │
       ▼
Cloudflare Edge  ──(banproof.me/api/*)──▶  banproof-core worker
                                                    │
                              ┌─────────────────────┼──────────────────────┐
                              ▼                     ▼                      ▼
                        Turnstile           D1: bp-core-prod          KV: CACHE
                        (bot check)        (users, cms, audit)     (session cache)
                              │                     │
                              ▼                     ▼
                       Stripe webhooks         Workers AI
                       (plan sync)           (LLM inference)
```

Static assets (`index.html`, CSS, JS) are served independently by the root
`wrangler.jsonc` config — the worker only intercepts `/api/*` paths.

---

## Quick-start

### 1 — Install dependencies

```bash
cd worker
npm install
```

### 2 — Create Cloudflare resources

```bash
# D1 database
npm run db:create
# → copy the database_id UUID and paste it into wrangler.toml [d1_databases]

# KV namespace
npm run kv:create
# → copy the id and paste it into wrangler.toml [kv_namespaces] binding = "CACHE"
```

### 3 — Apply the database schema

```bash
# Local (for development)
npm run db:migrate:local

# Production
npm run db:migrate
```

### 4 — Configure non-secret variables

Edit `wrangler.toml` and replace the placeholder strings:

| Key | Where to find it |
|---|---|
| `TURNSTILE_SITE_KEY` | Cloudflare Dashboard → Turnstile → your site → **Site Key** |
| `database_id` (D1) | Output of `wrangler d1 create bp-core-prod` |
| KV `id` (CACHE) | Output of `wrangler kv namespace create banproof-cache` |

### 5 — Upload secrets

Run each command from the `worker/` directory and paste the value when
prompted:

```bash
# Cloudflare Turnstile — Secret Key
wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.toml

# Stripe
wrangler secret put STRIPE_SECRET_KEY     --config wrangler.toml
wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.toml
wrangler secret put STRIPE_PRICE_ID_PRO   --config wrangler.toml

# Outbound email (MailChannels)
wrangler secret put MAILCHANNELS_API_KEY  --config wrangler.toml

# Cloudflare API token (for audit worker / ZT setup)
wrangler secret put CF_API_TOKEN          --config wrangler.toml

# GitHub PAT (for banproof-audit worker)
wrangler secret put GH_PAT               --config wrangler.toml
```

Where to find each value:

| Secret | Source |
|---|---|
| `TURNSTILE_SECRET_KEY` | CF Dashboard → Turnstile → your site → **Secret Key** |
| `STRIPE_SECRET_KEY` | [stripe.com → Developers → API keys](https://dashboard.stripe.com/apikeys) → **Secret key** (`sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | stripe.com → Webhooks → your endpoint → **Signing secret** (`whsec_...`) |
| `STRIPE_PRICE_ID_PRO` | stripe.com → Products → Pro plan → **Price ID** (`price_...`) |
| `MAILCHANNELS_API_KEY` | [platform.mailchannels.com](https://platform.mailchannels.com) → API keys |
| `CF_API_TOKEN` | CF Dashboard → My Profile → API Tokens → **Create Token** (Edit Cloudflare Workers template; scope to account + banproof.me) |
| `GH_PAT` | github.com → Settings → Developer settings → **Fine-grained tokens** (Permissions: Contents, Actions, Metadata — read; Repo: marzton/banproof.me) |

### 6 — Local development

```bash
# Copy the secret template
cp .dev.vars.example .dev.vars
# Fill in .dev.vars (git-ignored)

npm run dev
# Worker available at http://localhost:8787
```

### 7 — Deploy

```bash
npm run deploy
```

---

## Route map

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | None | Health check |
| `POST` | `/api/public/register` | Turnstile | New user registration |
| `GET` | `/api/public/cms/:slug` | Turnstile | Fetch published CMS content |
| `GET` | `/api/protected/me` | Turnstile + auth | Current user profile |
| `GET` | `/api/protected/cms` | Turnstile + auth | List CMS content |
| `GET` | `/api/pro/odds` | Turnstile + auth + Pro | Sports odds (wired to Odds API) |
| `POST` | `/api/pro/ai/analyze` | Turnstile + auth + Pro | AI inference via Workers AI |
| `GET` | `/api/admin/users` | auth + admin | List all users |
| `PATCH` | `/api/admin/users/:id/tier` | auth + admin | Change user plan tier |
| `GET` | `/api/admin/cms` | auth + admin | List all CMS entries (including drafts) |
| `POST` | `/api/admin/cms` | auth + admin | Create CMS entry |
| `POST` | `/api/webhooks/stripe` | Stripe signature | Subscription lifecycle events |

---

## Bindings reference

| Binding name | Type | Purpose |
|---|---|---|
| `DB` | D1 | Users, CMS, audit log |
| `CACHE` | KV | Session cache (5-min TTL) |
| `INFRA_SECRETS` | KV | GH_PAT and CF_API_TOKEN for audit worker |
| `AI` | Workers AI | LLM inference on Pro routes |
| `MAILER` | Email Workers | Transactional outbound email |

---

## Zero Trust admin panel

Run the setup script to lock `admin.banproof.me` behind Cloudflare Access:

```bash
export CF_API_TOKEN="<your-cf-api-token>"
export CF_ACCOUNT_ID="<your-account-id>"   # Right sidebar in CF dashboard
export ADMIN_EMAIL="admin@banproof.me"
export ZONE_ID="<banproof.me-zone-id>"     # CF Dashboard → banproof.me → Zone ID

chmod +x ../zero-trust/setup.sh
../zero-trust/setup.sh
```

This creates:
- **Access Application**: `banproof-admin` at `admin.banproof.me`  
- **Access Policy**: `admin-only` — only `ADMIN_EMAIL` can authenticate

After running, add a DNS CNAME `admin.banproof.me → banproof-core.workers.dev`
in the Cloudflare DNS dashboard.

---

## Email routing

1. CF Dashboard → **Email** → **Email Routing** → Enable on `banproof.me`
2. Add a verified destination: `hello@rmarston.com`
3. The `MAILER` binding is automatically available once Email Routing is active

---

## D1 schema

See [`../schema.sql`](../schema.sql).  Tables:

- `users` — email, Stripe customer ID, plan tier, subscription status
- `cms_content` — markdown content blocks by slug/category
- `audit_log` — user action trail
