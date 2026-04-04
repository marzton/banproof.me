import { describe, it, expect } from 'vitest';
import { SubscriptionPurchaseWorkflow, type SubscriptionPurchaseParams } from '../src/workflows/subscriptionPurchase.js';

type RowMap = {
  users: Array<{ id: string; plan_tier: 'free' | 'pro' | 'agency' }>;
  subscriptions: Array<{ id: string; user_id: string; plan_tier: string; status: string; stripe_subscription_id: string | null }>;
  audit_log: Array<{ id: number; user_id: string; action: string; metadata: string }>;
};

function makeD1({ failTierChange = false }: { failTierChange?: boolean } = {}) {
  const rows: RowMap = {
    users: [{ id: 'user_1', plan_tier: 'free' }],
    subscriptions: [],
    audit_log: [],
  };

  const stmt = (sql: string, bindings: unknown[]) => ({
    bind: (...args: unknown[]) => stmt(sql, [...bindings, ...args]),
    first: async <T>() => {
      const q = sql.toLowerCase();
      if (q.includes('select id from audit_log')) {
        const userId = String(bindings[0]);
        const pattern = String(bindings[1]).replace(/%/g, '');
        const row = [...rows.audit_log]
          .reverse()
          .find((r) => r.user_id === userId && r.action === 'tier_change' && r.metadata.includes(pattern));
        return (row as T) ?? null;
      }
      if (q.includes('from subscriptions where user_id')) {
        return (rows.subscriptions.find((r) => r.user_id === bindings[0]) as T) ?? null;
      }
      if (q.includes('from users where id')) {
        const user = rows.users.find((u) => u.id === bindings[0]);
        return user ? ({ plan_tier: user.plan_tier } as T) : null;
      }
      if (q.includes('last_insert_rowid')) {
        const latest = rows.audit_log[rows.audit_log.length - 1];
        return ({ id: latest?.id ?? null } as T);
      }
      return null;
    },
    run: async () => {
      const q = sql.toLowerCase();
      if (q.includes('insert into subscriptions')) {
        rows.subscriptions.push({
          id: String(bindings[0]),
          user_id: String(bindings[1]),
          stripe_subscription_id: (bindings[2] as string | null) ?? null,
          plan_tier: String(bindings[3]),
          status: String(bindings[4]),
        });
      }
      if (q.includes('update subscriptions')) {
        const id = String(bindings[6]);
        const sub = rows.subscriptions.find((s) => s.id === id);
        if (sub) {
          sub.stripe_subscription_id = (bindings[0] as string | null) ?? null;
          sub.plan_tier = String(bindings[1]);
          sub.status = String(bindings[2]);
        }
      }
      if (q.includes('update users set plan_tier')) {
        if (failTierChange) {
          throw new Error('forced tier update failure');
        }
        const nextTier = bindings[0] as 'free' | 'pro' | 'agency';
        const user = rows.users.find((u) => u.id === bindings[1]);
        if (user) user.plan_tier = nextTier;
      }
      if (q.includes('insert into audit_log')) {
        rows.audit_log.push({
          id: rows.audit_log.length + 1,
          user_id: String(bindings[0]),
          action: q.includes('tier_change_failed') ? 'tier_change_failed' : 'tier_change',
          metadata: String(bindings[1]),
        });
      }
      return { success: true };
    },
  });

  return {
    prepare: (sql: string) => stmt(sql, []),
    _rows: rows,
  };
}

function makeStep() {
  return {
    do: async (_name: string, fn: () => Promise<unknown>) => fn(),
  } as any;
}

function makeWorkflow(db: any) {
  const wf = new SubscriptionPurchaseWorkflow();
  (wf as any).env = { DB: db };
  return wf;
}

const basePayload: SubscriptionPurchaseParams = {
  userId: 'user_1',
  targetTier: 'pro',
  paymentEvent: {
    eventId: 'evt_1',
    provider: 'stripe',
    subscriptionId: 'sub_1',
  },
};

describe('SubscriptionPurchaseWorkflow', () => {
  it('processes a successful upgrade and writes subscription + audit records', async () => {
    const db = makeD1();
    const wf = makeWorkflow(db);

    const result = await wf.run({ payload: basePayload } as any, makeStep());

    expect(result.ok).toBe(true);
    expect(result.deduplicated).toBe(false);
    expect(db._rows.users[0].plan_tier).toBe('pro');
    expect(db._rows.subscriptions).toHaveLength(1);
    expect(db._rows.audit_log.some((r) => r.action === 'tier_change')).toBe(true);
  });

  it('deduplicates duplicate payment events', async () => {
    const db = makeD1();
    db._rows.audit_log.push({
      id: 1,
      user_id: 'user_1',
      action: 'tier_change',
      metadata: JSON.stringify({ paymentEventId: 'evt_1' }),
    });
    const wf = makeWorkflow(db);

    const result = await wf.run({ payload: basePayload } as any, makeStep());

    expect(result.deduplicated).toBe(true);
    expect(db._rows.subscriptions).toHaveLength(0);
  });

  it('writes failure audit and preserves recoverability on error paths', async () => {
    const db = makeD1({ failTierChange: true });
    const wf = makeWorkflow(db);

    await expect(wf.run({ payload: basePayload } as any, makeStep())).rejects.toThrow('forced tier update failure');
    expect(db._rows.users[0].plan_tier).toBe('free');
    expect(db._rows.audit_log.some((r) => r.action === 'tier_change_failed')).toBe(true);
  });
});
