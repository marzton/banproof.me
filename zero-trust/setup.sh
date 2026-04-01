#!/usr/bin/env bash
# ================================================================
# zero-trust/setup.sh — Cloudflare Access (Zero Trust) bootstrap
# ================================================================
# Creates a Cloudflare Access Application + Policy that locks
# admin.banproof.me (or banproof.me/admin/*) behind an email
# allow-list so only you can reach the admin panel.
#
# Prerequisites:
#   1. Export your credentials before running:
#        export CF_API_TOKEN="your-api-token"   # Edit Cloudflare Workers token
#        export CF_ACCOUNT_ID="your-account-id"
#        export ADMIN_EMAIL="admin@banproof.me"
#        export ZONE_ID="your-zone-id"          # banproof.me zone ID
#
#   2. Make executable:
#        chmod +x zero-trust/setup.sh
#
#   3. Run:
#        ./zero-trust/setup.sh
#
# Note: The CF_API_TOKEN needs "Access: Apps and Policies: Edit"
# permission.  Easiest way: create a token with the
# "Cloudflare Access: Edit" template from the CF dashboard.
# ================================================================
set -euo pipefail

: "${CF_API_TOKEN:?  Set CF_API_TOKEN before running}"
: "${CF_ACCOUNT_ID:? Set CF_ACCOUNT_ID before running}"
: "${ADMIN_EMAIL:?   Set ADMIN_EMAIL before running}"
: "${ZONE_ID:?       Set ZONE_ID before running (banproof.me zone ID)}"

BASE="https://api.cloudflare.com/client/v4"
AUTH_HEADER="Authorization: Bearer ${CF_API_TOKEN}"

echo "==> Creating Cloudflare Access Application: banproof-admin"

APP_RESPONSE=$(curl -s -X POST \
  "${BASE}/accounts/${CF_ACCOUNT_ID}/access/apps" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  --data '{
    "name":             "banproof-admin",
    "domain":           "admin.banproof.me",
    "type":             "self_hosted",
    "session_duration": "24h",
    "auto_redirect_to_identity": false,
    "http_only_cookie_attribute": true,
    "same_site_cookie_attribute": "lax",
    "skip_interstitial":         false
  }')

echo "${APP_RESPONSE}" | python3 -m json.tool 2>/dev/null || echo "${APP_RESPONSE}"

APP_ID=$(echo "${APP_RESPONSE}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['id'])")

if [[ -z "${APP_ID}" ]]; then
  echo "ERROR: Could not parse Access Application ID. Aborting."
  exit 1
fi

echo ""
echo "==> Application created. ID: ${APP_ID}"
echo "==> Creating Access Policy: admin-only"

POLICY_RESPONSE=$(curl -s -X POST \
  "${BASE}/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}/policies" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  --data "{
    \"name\":       \"admin-only\",
    \"decision\":   \"allow\",
    \"precedence\": 1,
    \"include\": [
      {
        \"email\": { \"email\": \"${ADMIN_EMAIL}\" }
      }
    ],
    \"require\": [],
    \"exclude\": []
  }")

echo "${POLICY_RESPONSE}" | python3 -m json.tool 2>/dev/null || echo "${POLICY_RESPONSE}"

POLICY_ID=$(echo "${POLICY_RESPONSE}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['id'])")

echo ""
echo "================================================================"
echo " Zero Trust bootstrap complete."
echo ""
echo "  Application:  banproof-admin  (ID: ${APP_ID})"
echo "  Policy:       admin-only      (ID: ${POLICY_ID})"
echo "  Protected:    https://admin.banproof.me"
echo "  Allowed:      ${ADMIN_EMAIL}"
echo ""
echo " Next steps:"
echo "  1. Add a CNAME  admin.banproof.me → <your-worker>.workers.dev"
echo "     in the Cloudflare DNS dashboard, or point it at the admin"
echo "     route served by the banproof-core worker."
echo "  2. Test by visiting https://admin.banproof.me — you should"
echo "     see the Cloudflare Access login screen."
echo "================================================================"
