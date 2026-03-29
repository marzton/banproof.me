export interface NodeRequest {
  ip: string;
  token: string;
}

export interface PoAResult {
  isValid: boolean;
  score: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  reason?: string;
}

const TRUSTED_TAILSCALE_IPS = ['100.100.100.1', '100.200.200.2'];

export const validateProofOfAgency = ({ ip, token }: NodeRequest): PoAResult => {
  // Temporary hardcoded validation logic
  if (token !== 'secret_agent_key_2026') {
    return {
      isValid: false,
      score: 0,
      riskLevel: 'HIGH',
      reason: 'Invalid or missing agent token.'
    };
  }

  // Check Tailscale DePIN Network Match
  // (In production, we'd query Tailscale API dynamically to establish residential match)
  const isTrustedIP = TRUSTED_TAILSCALE_IPS.includes(ip);
  if (!isTrustedIP && ip !== 'unknown' && ip !== '127.0.0.1') {
      return {
          isValid: false,
          score: 20,
          riskLevel: 'MEDIUM',
          reason: 'Execution node IP not part of DePIN registry.'
      }
  }

  return {
    isValid: true,
    score: 95,
    riskLevel: 'LOW'
  };
};
