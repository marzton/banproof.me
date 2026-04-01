# Zero-Edge SSO — Cloudflare Access Integration

Zero-Edge SSO is Banproof's zero-trust authentication layer. It uses **Cloudflare Access** to validate user identity *at the edge* — before any traffic reaches the Worker — via signed JWTs in the `Cf-Access-Jwt-Assertion` header.

---

## Architecture

```
User / Agent
    │
    ▼
┌──────────────────────────────────────────────┐
│         Cloudflare Edge (POP)                │
│                                              │
│  ┌──────────────────────┐                    │
│  │  Cloudflare Access   │  ← Zero-Edge Gate  │
│  │  Policy Enforcement  │                    │
│  │  (JWT issuance)      │                    │
│  └──────────┬───────────┘                    │
│             │ Cf-Access-Jwt-Assertion header  │
└─────────────┼────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────┐
│  banproof-core Worker                               │
│                                                     │
│  accessControlMiddleware (gateway/src/middleware/)  │
│  ┌────────────────────────────────────────────────┐ │
│  │ 1. Check Cf-Access-Jwt-Assertion (Zero-Edge)   │ │
│  │    └─ validateZeroEdgeJWT()  ← RS256 verify    │ │
│  │    └─ extractClaims()        ← AccessContext   │ │
│  │    └─ enforceRBAC()          ← role/tier check │ │
│  │                                                │ │
│  │ 2. Fallback: Authorization: Bearer (agent PoA) │ │
│  │    └─ validateProofOfAgency()                  │ │
│  │                                                │ │
│  │ 3. Enforce RBAC by route                       │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  Route Handlers → BanproofEngine (Workflow)         │
└─────────────────────────────────────────────────────┘
```

---

## Files

| File | Purpose |
|------|---------|
| `cloudflare-access-config.json` | Cloudflare Access application and policy definitions |
| `gateway/src/types/access.ts` | TypeScript types: `UserRole`, `TierLevel`, `ZeroEdgeIdentity`, `AccessContext` |
| `gateway/src/middleware/zeroEdgeSSO.ts` | JWT validation, claim extraction, RBAC functions |
| `gateway/src/middleware/accessControl.ts` | Hono middleware wiring everything together |
| `gateway/tests/accessControl.test.ts` | Test suite (17 scenarios) |
| `.env.example` | Environment variable reference |

---

## Role & Tier Hierarchy

```
public / free (0) < pro (2) < agency (3) < admin (4)
```

| Role/Tier | Can access |
|-----------|-----------|
| `public` / `free` | Public routes only (`/api/health`) |
| `pro` | `/api/pro/*` |
| `agency` | `/api/pro/*` (superset of pro) |
| `admin` | `/admin/*`, `/api/pro/*` (all routes) |

Admin access to `POST /admin/config` additionally requires the client IP to be in `TRUSTED_ADMIN_IPS`.

---

## Route Protection

| Route | Method | Required Role | IP Whitelist |
|-------|--------|---------------|--------------|
| `/api/health` | GET | public (no auth) | — |
| `/api/pro/*` | any | `pro` or above | no |
| `/admin/dashboard` | GET | `admin` | no |
| `/admin/config` | POST | `admin` | **yes** |
| `/admin/*` | any | `admin` | no |

---

## Setup Instructions

### 1. Create a Cloudflare Access Application

1. Log in to the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/)
2. Go to **Access → Applications → Add an application**
3. Select **Self-hosted**
4. Configure:
   - **Application name**: `Banproof Pro API`
   - **Application domain**: `banproof.me/api/pro/*`
   - **Session duration**: `24 hours`
5. Add a policy:
   - **Policy name**: `Pro Users`
   - **Action**: Allow
   - **Include**: Email domain → `banproof.me`
6. Under **Custom Claims**, add:
   - `role` → SAML attribute / OIDC claim `custom.role`
   - `tier_level` → SAML attribute / OIDC claim `custom.tier_level`
7. Save and note the **Audience Tag** (starts with `https://`)

Repeat for the `Admin` application (`banproof.me/admin/*`).

See `cloudflare-access-config.json` for the full reference configuration.

### 2. Retrieve the Public Key

Cloudflare Access uses RS256 JWTs. Fetch the public key:

```bash
curl https://<your-team>.cloudflareaccess.com/cdn-cgi/access/certs
```

Copy the PEM-encoded public key.

### 3. Set Secrets

```bash
# Audience tag from step 1
wrangler secret put CF_ACCESS_AUDIENCE --config gateway/wrangler.toml

# PEM public key from step 2
wrangler secret put CF_ZERO_EDGE_PUBLIC_KEY --config gateway/wrangler.toml

# Comma-separated trusted IPs for /admin/config
wrangler secret put TRUSTED_ADMIN_IPS --config gateway/wrangler.toml
```

### 4. Deploy

```bash
cd gateway
npm run deploy
```

---

## Policy Configuration Examples

### Allow Pro Users (Discord OAuth)

```json
{
  "name": "Require Pro Tier",
  "decision": "allow",
  "include": [
    { "email_domain": "banproof.me" },
    { "group": "pro-users" }
  ]
}
```

### Restrict Admin to Tailscale IPs

```json
{
  "name": "Block Non-Admin IPs",
  "decision": "deny",
  "include": [{ "ip": "0.0.0.0/0" }],
  "exclude": [
    { "ip": "100.100.100.0/24" },
    { "ip": "100.200.200.0/24" }
  ]
}
```

---

## Testing & Debugging

### Local Development (Mock SSO)

In development, set `CF_ACCESS_AUDIENCE=development` and skip the JWT header entirely — requests will fall back to agent token auth or be treated as public:

```bash
# .dev.vars (for wrangler dev)
CF_ACCESS_AUDIENCE=development
TRUSTED_ADMIN_IPS=127.0.0.1,::1
```

### Generate a Test JWT (Node.js)

```javascript
const { generateKeyPairSync, createSign } = require('crypto');

// Generate RSA key pair
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

// Build JWT
const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({
  sub: 'user-123',
  email: 'test@banproof.me',
  aud: ['https://banproof-core.marzton.workers.dev'],
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  custom: { role: 'pro', tier_level: 'pro', user_id: 'user-123' },
})).toString('base64url');

const sign = createSign('SHA256');
sign.update(`${header}.${payload}`);
const signature = sign.sign(privateKey).toString('base64url');

const jwt = `${header}.${payload}.${signature}`;
console.log('JWT:', jwt);
console.log('Public Key PEM:', publicKey.export({ type: 'spki', format: 'pem' }));
```

### Run Tests

```bash
cd gateway
npm test
```

---

## Integration with Existing Agent Token Auth

The middleware processes auth in priority order:

1. **Zero-Edge SSO** (`Cf-Access-Jwt-Assertion` header) — validated JWT from Cloudflare Access
2. **Agent Token** (`Authorization: Bearer <token>`) — validated via `validateProofOfAgency()`
3. **Public** — unauthenticated, only public routes allowed

If a JWT is present but **invalid** (wrong signature, expired, wrong audience), the request is **rejected with 401** — there is no fallback to agent token in this case. This prevents token substitution attacks.

---

## Troubleshooting

### 401 on protected routes — no JWT

If you're calling a protected route without a JWT and without an agent token, the middleware returns 401. This is expected. Add one of:
- `Cf-Access-Jwt-Assertion: <valid-jwt>` (Zero-Edge SSO)
- `Authorization: Bearer <your-dev-agent-token>` (agent token, dev only)

### 401 JWT validation errors

| Error message | Cause |
|---------------|-------|
| `Invalid JWT: malformed token` | The `Cf-Access-Jwt-Assertion` header is not a valid JWT |
| `Invalid JWT: token has expired` | The JWT `exp` claim is in the past |
| `Invalid JWT: audience mismatch` | The JWT `aud` claim doesn't match `CF_ACCESS_AUDIENCE` |
| `Invalid JWT: signature verification failed` | The JWT was signed with a different key |
| `Invalid JWT: cannot parse public key` | `CF_ZERO_EDGE_PUBLIC_KEY` is malformed or missing |

### 403 on admin routes

- **RBAC denied**: Your JWT role/tier is below `admin`. Ensure your Cloudflare Access policy sends `custom.role = "admin"`.
- **IP whitelist denied**: Your IP is not in `TRUSTED_ADMIN_IPS`. Add it via `wrangler secret put TRUSTED_ADMIN_IPS`.

### Cloudflare Access not issuing JWTs

Ensure:
1. The Cloudflare Access application path matches the request URL
2. The user has completed the Access login flow (check Access → Audit Logs)
3. The `Cf-Access-Jwt-Assertion` header is forwarded by your proxy/ingress

---

## Environment Variables Reference

See `.env.example` for the full list. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `CF_ACCESS_AUDIENCE` | Yes | Audience tag from Cloudflare Access app |
| `CF_ZERO_EDGE_PUBLIC_KEY` | Yes (production) | PEM public key for JWT signature verification |
| `TRUSTED_ADMIN_IPS` | No | Comma-separated IPs allowed to call `POST /admin/config` |
| `CF_ACCESS_APP_ID` | No | Reference to the Cloudflare Access app ID |
