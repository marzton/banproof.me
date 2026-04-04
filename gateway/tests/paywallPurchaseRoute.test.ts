import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';

function req(body: unknown) {
  return new Request('http://localhost/api/paywall/purchase/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/paywall/purchase/complete', () => {
  it('creates a workflow instance for a valid payload', async () => {
    const env = {
      PURCHASE_WORKFLOW: { create: async () => ({ id: 'wf_purchase_1' }) },
    } as any;

    const res = await worker.fetch(req({
      userId: 'user_1',
      targetTier: 'pro',
      paymentEvent: { eventId: 'evt_1', provider: 'stripe' },
    }), env);

    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.workflowId).toBe('wf_purchase_1');
  });

  it('returns 400 for invalid payload', async () => {
    const env = {
      PURCHASE_WORKFLOW: { create: async () => ({ id: 'wf_purchase_1' }) },
    } as any;

    const res = await worker.fetch(req({ userId: 'user_1' }), env);
    expect(res.status).toBe(400);
  });
});
