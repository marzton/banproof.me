// ============================================================
// Zero-Edge Access — Type Definitions
// Shared types for Cloudflare Access JWT validation and RBAC
// ============================================================

export type UserRole = 'public' | 'pro' | 'agency' | 'admin';
export type TierLevel = 'free' | 'pro' | 'agency';

/** Validated identity extracted from a Cloudflare Access JWT */
export interface ZeroEdgeIdentity {
  userId: string;
  email: string;
  role: UserRole;
  tierLevel: TierLevel;
  groups?: string[];
  expiresAt: number; // Unix timestamp (seconds)
}

/** Unified access context attached to each request */
export interface AccessContext {
  identity: ZeroEdgeIdentity;
  method: 'zero-edge-sso' | 'agent-token' | 'public';
  ipAddress: string;
  timestamp: number; // Unix timestamp (milliseconds)
}
