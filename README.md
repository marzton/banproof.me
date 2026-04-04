# rmarston.com — Durable Intelligence Architecture

This repository contains the source code and configuration for **rmarston.com** (and its sister brand **banproof.me**). The architecture is built entirely on the Cloudflare stack, utilizing Workers, Workers Assets, D1, KV, R2, and Workflows.

## Architecture Overview

The project is structured as a monorepo:

- **Root Directory**: Serves static assets (`index.html`, CSS, JS) via [Cloudflare Workers Assets](https://developers.cloudflare.com/workers/static-assets/).
- **`gateway/`**: The core API engine (`banproof-core`) built with Hono. It handles authentication, database interactions (D1), caching (KV), and long-running processes (Workflows).
- **`packages/`**: Shared libraries and types used across the project.
- **`worker/`**: (Legacy) Previous version of the API, kept for reference.

---

## Deployment & Setup

### 1. Prerequisites

- A Cloudflare account with a funded Workers paid plan (required for Workflows).
- `wrangler` CLI installed: `npm install -g wrangler`
- Domains `rmarston.com` and `banproof.me` added to your Cloudflare account.

### 2. Infrastructure Setup

Create the necessary Cloudflare resources:

```bash
# D1 Database
wrangler d1 create bp-core-prod

# KV Namespaces
wrangler kv namespace create banproof-cache
wrangler kv namespace create infra-secrets

# R2 Bucket
wrangler r2 bucket create f77de112d2019e5456a3198a8bb50bd2
```

Update the `database_id` and `id` values in `gateway/wrangler.toml` with the output from the commands above.

### 3. Database Migration

Initialize the production database schema:

```bash
cd gateway
npx wrangler d1 execute bp-core-prod --file=../schema.sql
```

### 4. Secret Management

Upload the required secrets to the `gateway` worker:

```bash
cd gateway
wrangler secret put JWT_SECRET
wrangler secret put HF_API_TOKEN
wrangler secret put ODDS_API_KEY
wrangler secret put CF_ZERO_EDGE_PUBLIC_KEY
wrangler secret put TRUSTED_ADMIN_IPS
```

### 5. Deployment

Deployment is automated via GitHub Actions on every push to the `main` branch.

To deploy manually:

**Deploy Static Site (Root):**
```bash
wrangler deploy
```

**Deploy API Gateway:**
```bash
cd gateway
npm install
wrangler deploy
```

---

## Local Development

1. Install dependencies at the workspace root:
   ```bash
   pnpm install
   ```

2. Start the gateway in development mode:
   ```bash
   cd gateway
   npm run dev
   ```

3. View the static site:
   You can use a local static server (like `npx serve .`) to view `index.html`.

---

## Zero-Edge SSO

The admin panel and pro API routes are protected by **Cloudflare Access**.

- **Audience Tag**: Configured in `gateway/wrangler.toml` as `CF_ACCESS_AUDIENCE`.
- **JWT Verification**: Handled at the edge using the public key stored in `CF_ZERO_EDGE_PUBLIC_KEY`.

For detailed configuration, see [ZERO_EDGE_SSO.md](./ZERO_EDGE_SSO.md).

---

## Testing

Run the test suite in the gateway directory:

```bash
cd gateway
npm test
```

Refer to [gateway/TESTING_CHECKLIST.md](./gateway/TESTING_CHECKLIST.md) for pre-deployment verification steps.
