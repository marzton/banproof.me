// ============================================================
// Zero-Edge SSO — Cloudflare Access JWT Validator
// Validates Cf-Access-Jwt-Assertion tokens and extracts claims
// ============================================================

import type { ZeroEdgeIdentity, AccessContext, UserRole, TierLevel } from '../types/access.js';

// Role/tier hierarchy used for RBAC comparisons
const ROLE_LEVELS: Record<string, number> = {
  public: 0,
  free: 0,
  pro: 2,
  agency: 3,
  admin: 4,
};

// ── JWT decode helpers ────────────────────────────────────────

/** Decode a base64url string to a Uint8Array */
function base64UrlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Convert a PEM public key to an ArrayBuffer for Web Crypto */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const lines = pem
    .split('\n')
    .filter((l) => !l.startsWith('-----') && l.trim() !== '');
  const base64 = lines.join('');
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return buffer;
}

// ── Raw JWT payload shape ─────────────────────────────────────

interface CfAccessJWTPayload {
  sub?: string;
  email?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  iss?: string;
  /** Custom claims set via Cloudflare Access policy */
  custom?: {
    user_id?: string;
    role?: string;
    tier_level?: string;
  };
  /** Alternative namespace for custom claims */
  'com.banproof'?: {
    role?: string;
    tier_level?: string;
  };
}

// ── Public API ────────────────────────────────────────────────

/**
 * Validate a Cloudflare Access JWT (Cf-Access-Jwt-Assertion header).
 * Verifies the RS256 signature, expiry, and audience claim.
 *
 * @param token      Raw JWT string from the Cf-Access-Jwt-Assertion header
 * @param audience   Expected audience (CF_ACCESS_AUDIENCE env var)
 * @param publicKeyPem  PEM-encoded RSA public key for signature verification
 * @returns Parsed and validated ZeroEdgeIdentity
 * @throws  Error if the token is malformed, expired, or has an invalid signature
 */
export async function validateZeroEdgeJWT(
  token: string,
  audience: string,
  publicKeyPem: string,
): Promise<ZeroEdgeIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT: malformed token (expected 3 parts)');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode and parse payload
  let payload: CfAccessJWTPayload;
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(payloadJson) as CfAccessJWTPayload;
  } catch {
    throw new Error('Invalid JWT: cannot decode payload');
  }

  // Validate expiry
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) {
    throw new Error('Invalid JWT: token has expired');
  }

  // Validate audience
  // A missing/empty audience configuration is treated as an error to avoid
  // accidentally accepting tokens with any aud value.
  if (!audience || !audience.trim()) {
    throw new Error('Invalid JWT: missing audience configuration');
  }
  const audList = Array.isArray(payload.aud)
    ? payload.aud
    : payload.aud != null ? [payload.aud] : [];
  if (!audList.length || !audList.includes(audience)) {
    throw new Error('Invalid JWT: audience mismatch');
  }

  // Verify RS256 signature using Web Crypto API
  let keyData: ArrayBuffer;
  try {
    keyData = pemToArrayBuffer(publicKeyPem);
  } catch {
    throw new Error('Invalid JWT: cannot parse public key');
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'spki',
      keyData,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    throw new Error('Invalid JWT: cannot import public key');
  }

  const signatureBytes = base64UrlDecode(signatureB64);
  const dataToVerify = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const isValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signatureBytes,
    dataToVerify,
  );

  if (!isValid) {
    throw new Error('Invalid JWT: signature verification failed');
  }

  // Extract identity from custom claims
  const custom = payload.custom ?? payload['com.banproof'] ?? {};
  const userId = custom.user_id ?? payload.sub ?? '';
  const email = payload.email ?? '';
  const role = (custom.role as UserRole | undefined) ?? 'public';
  const tierLevel = (custom.tier_level as TierLevel | undefined) ?? 'free';

  return {
    userId,
    email,
    role,
    tierLevel,
    expiresAt: payload.exp,
  };
}

/**
 * Build an AccessContext from a validated ZeroEdgeIdentity.
 * The caller is responsible for setting ipAddress and timestamp.
 */
export function extractClaims(identity: ZeroEdgeIdentity): AccessContext {
  return {
    identity,
    method: 'zero-edge-sso',
    ipAddress: '', // caller must set
    timestamp: Date.now(),
  };
}

/**
 * Enforce role-based access control.
 * Uses a combined role + tier hierarchy so that a higher tier
 * (e.g. agency) satisfies a lower requirement (e.g. pro).
 *
 * Hierarchy: public = free (0) < pro (2) < agency (3) < admin (4)
 *
 * An unknown `requiredRole` value defaults to MAX_SAFE_INTEGER so that
 * mis-configured routes deny access rather than accidentally granting it.
 */
export function enforceRBAC(context: AccessContext, requiredRole: UserRole | TierLevel): boolean {
  const required = ROLE_LEVELS[requiredRole] ?? Number.MAX_SAFE_INTEGER;
  const byRole = ROLE_LEVELS[context.identity.role] ?? 0;
  const byTier = ROLE_LEVELS[context.identity.tierLevel] ?? 0;
  return Math.max(byRole, byTier) >= required;
}
