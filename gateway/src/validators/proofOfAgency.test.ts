import { describe, it, expect } from 'vitest';
import { validateProofOfAgency } from './proofOfAgency.js';

// Dev-only placeholder token defined in proofOfAgency.ts — NOT a real credential.
const VALID_TOKEN = 'secret_agent_key_2026';
const TRUSTED_IP_1 = '100.100.100.1';
const TRUSTED_IP_2 = '100.200.200.2';
const LOCALHOST = '127.0.0.1';
const UNKNOWN_IP = 'unknown';
const UNTRUSTED_IP = '203.0.113.42';

describe('validateProofOfAgency', () => {
  // ── Token validation ──────────────────────────────────────────────

  it('rejects a missing/empty token', () => {
    const result = validateProofOfAgency({ ip: TRUSTED_IP_1, token: '' });
    expect(result.isValid).toBe(false);
    expect(result.riskLevel).toBe('HIGH');
    expect(result.score).toBe(0);
    expect(result.reason).toBeTruthy();
  });

  it('rejects an invalid token', () => {
    const result = validateProofOfAgency({ ip: TRUSTED_IP_1, token: 'wrong_token' });
    expect(result.isValid).toBe(false);
    expect(result.riskLevel).toBe('HIGH');
    expect(result.score).toBe(0);
  });

  it('rejects a near-miss token (case sensitive)', () => {
    const result = validateProofOfAgency({ ip: TRUSTED_IP_1, token: 'Secret_Agent_Key_2026' });
    expect(result.isValid).toBe(false);
    expect(result.riskLevel).toBe('HIGH');
  });

  // ── IP + Token combinations ───────────────────────────────────────

  it('accepts a valid token from trusted Tailscale IP #1', () => {
    const result = validateProofOfAgency({ ip: TRUSTED_IP_1, token: VALID_TOKEN });
    expect(result.isValid).toBe(true);
    expect(result.riskLevel).toBe('LOW');
    expect(result.score).toBeGreaterThan(0);
  });

  it('accepts a valid token from trusted Tailscale IP #2', () => {
    const result = validateProofOfAgency({ ip: TRUSTED_IP_2, token: VALID_TOKEN });
    expect(result.isValid).toBe(true);
    expect(result.riskLevel).toBe('LOW');
    expect(result.score).toBeGreaterThan(0);
  });

  it('accepts a valid token from localhost (development mode)', () => {
    const result = validateProofOfAgency({ ip: LOCALHOST, token: VALID_TOKEN });
    expect(result.isValid).toBe(true);
    expect(result.riskLevel).toBe('LOW');
  });

  it('accepts a valid token when IP is "unknown" (header absent)', () => {
    const result = validateProofOfAgency({ ip: UNKNOWN_IP, token: VALID_TOKEN });
    expect(result.isValid).toBe(true);
    expect(result.riskLevel).toBe('LOW');
  });

  it('rejects a valid token from an untrusted external IP', () => {
    const result = validateProofOfAgency({ ip: UNTRUSTED_IP, token: VALID_TOKEN });
    expect(result.isValid).toBe(false);
    expect(result.riskLevel).toBe('MEDIUM');
    expect(result.score).toBe(20);
    expect(result.reason).toMatch(/DePIN/i);
  });

  // ── Return shape ──────────────────────────────────────────────────

  it('always returns isValid, score, and riskLevel fields', () => {
    const result = validateProofOfAgency({ ip: TRUSTED_IP_1, token: VALID_TOKEN });
    expect(result).toHaveProperty('isValid');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('riskLevel');
  });

  it('sets score to 95 for a fully trusted request', () => {
    const result = validateProofOfAgency({ ip: TRUSTED_IP_1, token: VALID_TOKEN });
    expect(result.score).toBe(95);
  });
});
