# Banproof Testing Checklist

All checks must pass before flipping `USE_MOCK=false` in production.

---

## 1. Local Testing (wrangler dev)

```sh
cd gateway && wrangler dev --env development
```

- [ ] `GET /api/health` returns `{ status: "ok", database: true, workflow: true, mock: true }`
- [ ] `POST /auth/signup` creates a user (returns `{ userId }`)
- [ ] `POST /auth/signin` returns `accessToken` + `refreshToken`
- [ ] `POST /auth/refresh` returns a new `accessToken`
- [ ] `POST /auth/logout` marks sessions as `revoked_at`
- [ ] `POST /api/pro/analyze` triggers a workflow (returns `workflowId`)
- [ ] D1 `audit_log` table has rows after each call
- [ ] `GET /admin/dashboard` returns stats and recent inquiries

---

## 2. Staging Testing (staging-api.banproof.me)

```sh
cd gateway && wrangler deploy --env staging
```

- [ ] HTTPS on `staging-api.banproof.me` responds to `/api/health`
- [ ] Auth flow works end-to-end (signup → signin → protected endpoint)
- [ ] Rate limiter returns `429` after exceeding free tier (10 req/min)
- [ ] CORS headers are present for `https://banproof.me` origin
- [ ] Admin dashboard loads at `/admin/index.html` (requires admin JWT)
- [ ] `POST /admin/users/:id/tier` updates tier and logs to `admin_audit_log`
- [ ] `POST /admin/inquiries/:id/quote` updates inquiry status
- [ ] Error handling: missing body returns `400`, bad JWT returns `401`

---

## 3. Production Testing with Mocks (24-hour monitoring)

```sh
cd gateway && wrangler deploy
# USE_MOCK=true in wrangler.toml — safe to run
```

- [ ] Workflow engine runs to completion (check Cloudflare Workflow dashboard)
- [ ] All three tiers tested: free, pro, agency
- [ ] Agency tier: Discord webhook log visible in `console.log` (webhook not set yet)
- [ ] D1 `audit_log` accumulates SENTIMENT_ONLY, ODDS_ANALYSIS, AGENCY_FULL_ANALYSIS
- [ ] Admin panel accessible at `/admin/` — login with admin credentials
- [ ] Monitor Cloudflare Workers logs for 24 hours: no 5xx errors

---

## 4. Pre-flip Checklist (before `USE_MOCK=false`)

- [ ] D1 database backed up: `wrangler d1 export bp-core-prod --output=backup.sql`
- [ ] `JWT_SECRET` secret uploaded: `wrangler secret put JWT_SECRET`
- [ ] `HF_API_TOKEN` secret uploaded: `wrangler secret put HF_API_TOKEN`
- [ ] `ODDS_API_KEY` secret uploaded: `wrangler secret put ODDS_API_KEY`
- [ ] `DISCORD_WEBHOOK` secret uploaded (optional): `wrangler secret put DISCORD_WEBHOOK`
- [ ] Team notified of go-live time
- [ ] Rollback plan ready: `git revert` and redeploy (< 2 min)
- [ ] Rate limits tested against real user volumes on staging
- [ ] Mobile test: full auth flow on phone at `https://banproof.me`

---

## 5. Post-flip Checklist (first 24 hours after `USE_MOCK=false`)

- [ ] Monitor HuggingFace API cost dashboard (stay under budget)
- [ ] Monitor Odds API request count (check quota)
- [ ] Verify AI analysis accuracy (sentiment label vs. market reality)
- [ ] Check billing dashboard: no unexpected charges
- [ ] D1 `audit_log` rows contain real sentiment/odds data
- [ ] Discord channel receiving agency-tier signals
- [ ] Error rate < 1% on `POST /api/pro/analyze`
- [ ] Admin receives marstonr6@gmail.com notifications (if wired)

---

## Rollback Procedure

If issues arise after flipping `USE_MOCK=false`:

```sh
# 1. Revert in wrangler.toml
# Change: USE_MOCK = "false"  →  USE_MOCK = "true"

# 2. Redeploy immediately
cd gateway && wrangler deploy

# 3. Notify team via Discord
# 4. Investigate logs via: wrangler tail
```

Total rollback time: **< 2 minutes**
