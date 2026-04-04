import { describe, it, expect } from 'vitest';
import { app } from '../index.js';

describe('GET /public/milestones', () => {
  it('returns unrestricted milestones data', async () => {
    const res = await app.request('/public/milestones');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ message: 'Public milestones data', status: 'unrestricted' });
  });
});

describe('POST /api/verify', () => {
  it('returns 401 without auth token', async () => {
    const res = await app.request('/api/verify', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON body when authenticated', async () => {
    const res = await app.request('/api/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret_agent_key_2026', 'Content-Type': 'application/json' },
      body: 'not valid json',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'Invalid JSON body' });
  });

  it('verifies a valid JSON payload when authenticated', async () => {
    const payload = { agentId: 'agent-42' };
    const res = await app.request('/api/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret_agent_key_2026', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(payload);
  });
});

describe('GET /api/data/goldshore', () => {
  it('returns 401 without auth token', async () => {
    const res = await app.request('/api/data/goldshore');
    expect(res.status).toBe(401);
  });

  it('returns goldshore data when authenticated', async () => {
    const res = await app.request('/api/data/goldshore', {
      headers: { Authorization: 'Bearer secret_agent_key_2026' },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual({ drsScore: 85, recommendation: 'Approve' });
  });
});
