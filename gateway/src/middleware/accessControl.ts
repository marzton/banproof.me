// ============================================================
// Access Control Middleware
// Integrates Zero-Edge SSO with existing tollBooth fallback.
//
// Priority:
//   1. Cf-Access-Jwt-Assertion (Zero-Edge identity)
//   2. Authorization: Bearer <token> (agent token / PoA)
//   3. Public (unauthenticated, limited to public routes)
// ============================================================

import type { MiddlewareHandler } from 'hono';
import type { AccessContext, UserRole, TierLevel } from '../types/access.js';
import { validateZeroEdgeJWT, extractClaims, enforceRBAC } from './zeroEdgeSSO.js';
import { validateProofOfAgency } from '../validators/proofOfAgency.js';

// ── Route permission table ────────────────────────────────────

interface RoutePermission {
  pathPrefix: string;
  method?: string; // undefined = all methods
  requiredRole: UserRole | TierLevel;
  requireTrustedIp: boolean;
}

const ROUTE_PERMISSIONS: RoutePermission[] = [
  { pathPrefix: '/admin/config',    method: 'POST', requiredRole: 'admin', requireTrustedIp: true  },
  { pathPrefix: '/admin/dashboard', method: 'GET',  requiredRole: 'admin', requireTrustedIp: false },
  { pathPrefix: '/admin/',                          requiredRole: 'admin', requireTrustedIp: false },
  { pathPrefix: '/api/pro/',                        requiredRole: 'pro',   requireTrustedIp: false },
];

// Routes that are always public — no auth needed
const PUBLIC_ROUTES = new Set(['/api/health']);

// Default trusted IPs for admin routes — fail closed in all environments.
// Development overrides are applied via TRUSTED_ADMIN_IPS env var binding.
const DEFAULT_TRUSTED_ADMIN_IPS: string[] = [];

// ── Middleware ────────────────────────────────────────────────

export const accessControlMiddleware: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const method = c.req.method;

  // Resolve client IP from Cloudflare headers first, then standard header
  const ipAddress =
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')?.[0]?.trim() ??
    'unknown';

  // ── CORS preflight bypass ─────────────────────────────────
  // OPTIONS requests must not be blocked so browser preflight succeeds.
  // The actual request that follows will be authenticated normally.

  if (method === 'OPTIONS') {
    await next();
    return;
  }

  // ── Public route bypass ───────────────────────────────────

  if (PUBLIC_ROUTES.has(path)) {
    console.log(`[Access Control] Public route — bypassing auth: ${method} ${path}`);
    await next();
    return;
  }

  // ── Attempt Zero-Edge SSO (Cf-Access-Jwt-Assertion) ───────

  let accessContext: AccessContext | null = null;
  const jwtToken = c.req.header('Cf-Access-Jwt-Assertion');

  if (jwtToken) {
    const env = c.env as Record<string, string | undefined>;
    const audience = env.CF_ACCESS_AUDIENCE ?? '';
    const publicKey = env.CF_ZERO_EDGE_PUBLIC_KEY ?? '';

    try {
      const identity = await validateZeroEdgeJWT(jwtToken, audience, publicKey);
      const base = extractClaims(identity);
      accessContext = { ...base, ipAddress, timestamp: Date.now() };
      console.log(
        `[Access Control] Zero-Edge SSO accepted — role=${identity.role} tier=${identity.tierLevel}`,
      );
    } catch (err) {
      // Invalid JWT — reject immediately; do not fall back to agent token
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[Access Control] Zero-Edge SSO rejected — ${reason}`);
      return c.json({ error: 'Unauthorized: invalid or expired JWT' }, 401);
    }
  }

  // ── Fall back to agent token (Authorization: Bearer) ──────

  if (!accessContext) {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token) {
      const poaResult = validateProofOfAgency({ ip: ipAddress, token });

      if (poaResult.isValid) {
        accessContext = {
          identity: {
            userId: 'agent',
            email: '',
            role: 'pro' as UserRole,
            tierLevel: 'pro' as TierLevel,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
          method: 'agent-token',
          ipAddress,
          timestamp: Date.now(),
        };
        console.log(
          `[Access Control] Agent token accepted — score=${poaResult.score} ip=${ipAddress}`,
        );
      }
      // Invalid agent token: fall through to public context (will be denied below if route is protected)
    }
  }

  // ── Build public context if no auth was provided ──────────

  if (!accessContext) {
    accessContext = {
      identity: {
        userId: '',
        email: '',
        role: 'public' as UserRole,
        tierLevel: 'free' as TierLevel,
        expiresAt: 0,
      },
      method: 'public',
      ipAddress,
      timestamp: Date.now(),
    };
  }

  // Attach context to request for downstream handlers
  c.set('accessContext', accessContext);

  // ── Enforce route permissions ──────────────────────────────

  const permission = ROUTE_PERMISSIONS.find((p) => {
    const pathMatch = path.startsWith(p.pathPrefix);
    const methodMatch = p.method === undefined || p.method === method;
    return pathMatch && methodMatch;
  });

  if (permission) {
    // Check role/tier hierarchy
    if (!enforceRBAC(accessContext, permission.requiredRole)) {
      const status = accessContext.method === 'public' ? 401 : 403;
      console.warn(
        `[Access Control] RBAC denied — path=${path} required=${permission.requiredRole} ` +
        `role=${accessContext.identity.role} tier=${accessContext.identity.tierLevel} method=${accessContext.method}`,
      );
      return c.json(
        { error: `Access denied: '${permission.requiredRole}' role required` },
        status,
      );
    }

    // Check IP whitelist for admin routes that require it
    if (permission.requireTrustedIp) {
      const env = c.env as Record<string, string | undefined>;
      const rawIps = env.TRUSTED_ADMIN_IPS ?? DEFAULT_TRUSTED_ADMIN_IPS.join(',');
      const trustedIps = rawIps.split(',').map((ip) => ip.trim());

      if (!trustedIps.includes(ipAddress)) {
        console.warn(
          `[Access Control] IP whitelist denied — path=${path} ip=${ipAddress}`,
        );
        return c.json({ error: 'Access denied: IP address not in admin whitelist' }, 403);
      }
    }
  }

  console.log(
    `[Access Control] Allowed — ${method} ${path} method=${accessContext.method} role=${accessContext.identity.role}`,
  );
  await next();
};
