import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

type PlanTier = 'free' | 'pro' | 'agency';

type PaymentEventMetadata = {
  eventId: string;
  provider: 'stripe' | 'manual' | 'other';
  subscriptionId?: string;
  status?: 'active' | 'canceled' | 'past_due' | 'trialing';
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  autoRenew?: boolean;
  processedAt?: string;
  [key: string]: unknown;
};

type Env = {
  DB: D1Database;
  QUEUE?: Queue<{ type: string; payload: Record<string, unknown> }>;
};

export type SubscriptionPurchaseParams = {
  userId: string;
  targetTier: PlanTier;
  paymentEvent: PaymentEventMetadata;
  notify?: boolean;
};

type ValidatedPayload = {
  userId: string;
  targetTier: PlanTier;
  paymentEvent: Required<Pick<PaymentEventMetadata, 'eventId' | 'provider'>> & PaymentEventMetadata;
  notify: boolean;
};

async function withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

export class SubscriptionPurchaseWorkflow extends WorkflowEntrypoint<Env, SubscriptionPurchaseParams> {
  async run(event: WorkflowEvent<SubscriptionPurchaseParams>, step: WorkflowStep) {
    let previousTier: PlanTier | null = null;
    const startedAt = new Date().toISOString();

    try {
      const payload = await step.do('validate-input', async () => {
        const raw = event.payload;
        const targetTier = raw?.targetTier;
        if (!raw?.userId || typeof raw.userId !== 'string') {
          throw new Error('Invalid userId.');
        }
        if (!targetTier || !['free', 'pro', 'agency'].includes(targetTier)) {
          throw new Error('Invalid targetTier.');
        }
        if (!raw.paymentEvent || typeof raw.paymentEvent !== 'object') {
          throw new Error('paymentEvent metadata is required.');
        }
        if (!raw.paymentEvent.eventId || typeof raw.paymentEvent.eventId !== 'string') {
          throw new Error('paymentEvent.eventId is required.');
        }
        if (!raw.paymentEvent.provider || typeof raw.paymentEvent.provider !== 'string') {
          throw new Error('paymentEvent.provider is required.');
        }

        return {
          userId: raw.userId,
          targetTier,
          paymentEvent: raw.paymentEvent as Required<Pick<PaymentEventMetadata, 'eventId' | 'provider'>> & PaymentEventMetadata,
          notify: raw.notify ?? true,
        } satisfies ValidatedPayload;
      });

      const duplicate = await step.do('idempotency-check', async () => {
        const row = await withRetries(() =>
          this.env.DB.prepare(
            `SELECT id FROM audit_log
             WHERE user_id = ? AND action = 'tier_change' AND metadata LIKE ?
             ORDER BY id DESC LIMIT 1`,
          )
            .bind(payload.userId, `%\"paymentEventId\":\"${payload.paymentEvent.eventId}\"%`)
            .first<{ id: number }>(),
        );

        return { alreadyProcessed: Boolean(row?.id) };
      });

      if (duplicate.alreadyProcessed) {
        return {
          ok: true,
          deduplicated: true,
          userId: payload.userId,
          eventId: payload.paymentEvent.eventId,
        };
      }

      const subscription = await step.do('upsert-subscription', async () => {
        return withRetries(async () => {
          const existing = await this.env.DB.prepare(
            `SELECT id FROM subscriptions WHERE user_id = ? LIMIT 1`,
          )
            .bind(payload.userId)
            .first<{ id: string }>();

          const status = payload.paymentEvent.status ?? 'active';
          const start = payload.paymentEvent.currentPeriodStart ?? payload.paymentEvent.processedAt ?? startedAt;
          const end = payload.paymentEvent.currentPeriodEnd ?? null;
          const autoRenew = payload.paymentEvent.autoRenew === false ? 0 : 1;

          if (existing?.id) {
            await this.env.DB.prepare(
              `UPDATE subscriptions
               SET stripe_subscription_id = ?, plan_tier = ?, status = ?,
                   current_period_start = ?, current_period_end = ?, auto_renew = ?
               WHERE id = ?`,
            )
              .bind(
                payload.paymentEvent.subscriptionId ?? null,
                payload.targetTier,
                status,
                start,
                end,
                autoRenew,
                existing.id,
              )
              .run();

            return { id: existing.id, operation: 'updated' as const };
          }

          const id = crypto.randomUUID();
          await this.env.DB.prepare(
            `INSERT INTO subscriptions
              (id, user_id, stripe_subscription_id, plan_tier, status, current_period_start, current_period_end, auto_renew)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              id,
              payload.userId,
              payload.paymentEvent.subscriptionId ?? null,
              payload.targetTier,
              status,
              start,
              end,
              autoRenew,
            )
            .run();

          return { id, operation: 'inserted' as const };
        });
      });

      await step.do('update-user-tier', async () => {
        return withRetries(async () => {
          const user = await this.env.DB.prepare(
            `SELECT plan_tier FROM users WHERE id = ? LIMIT 1`,
          )
            .bind(payload.userId)
            .first<{ plan_tier: PlanTier }>();

          if (!user) {
            throw new Error(`User ${payload.userId} not found.`);
          }

          previousTier = user.plan_tier;

          if (user.plan_tier !== payload.targetTier) {
            await this.env.DB.prepare(
              `UPDATE users SET plan_tier = ? WHERE id = ?`,
            )
              .bind(payload.targetTier, payload.userId)
              .run();
          }

          return { previousTier: user.plan_tier, nextTier: payload.targetTier };
        });
      });

      const auditId = await step.do('write-audit-log', async () => {
        return withRetries(async () => {
          const auditMetadata = {
            paymentEventId: payload.paymentEvent.eventId,
            provider: payload.paymentEvent.provider,
            subscriptionId: payload.paymentEvent.subscriptionId ?? null,
            subscriptionRowId: subscription.id,
            targetTier: payload.targetTier,
            processedAt: new Date().toISOString(),
          };

          await this.env.DB.prepare(
            `INSERT INTO audit_log (user_id, action, metadata)
             VALUES (?, 'tier_change', ?)`,
          )
            .bind(payload.userId, JSON.stringify(auditMetadata))
            .run();

          const inserted = await this.env.DB.prepare('SELECT last_insert_rowid() AS id').first<{ id: number }>();
          return inserted?.id ?? null;
        });
      });

      if (payload.notify && this.env.QUEUE) {
        await step.do('enqueue-notification', async () => {
          await withRetries(() =>
            this.env.QUEUE!.send({
              type: 'tier_upgraded',
              payload: {
                userId: payload.userId,
                targetTier: payload.targetTier,
                paymentEventId: payload.paymentEvent.eventId,
              },
            }),
          );
          return { enqueued: true };
        });
      }

      return {
        ok: true,
        deduplicated: false,
        subscriptionId: subscription.id,
        auditId,
      };
    } catch (err) {
      if (previousTier) {
        try {
          await step.do('rollback-user-tier', async () => {
            await this.env.DB.prepare(
              `UPDATE users SET plan_tier = ? WHERE id = ?`,
            )
              .bind(previousTier, event.payload.userId)
              .run();
            return { rolledBackTo: previousTier };
          });
        } catch (rollbackErr) {
          console.error('[SubscriptionPurchaseWorkflow] rollback failed', rollbackErr);
        }
      }

      await step.do('write-failure-audit', async () => {
        await this.env.DB.prepare(
          `INSERT INTO audit_log (user_id, action, metadata)
           VALUES (?, 'tier_change_failed', ?)`,
        )
          .bind(
            event.payload.userId,
            JSON.stringify({
              error: String(err),
              targetTier: event.payload.targetTier,
              paymentEventId: event.payload.paymentEvent?.eventId ?? null,
              failedAt: new Date().toISOString(),
            }),
          )
          .run()
          .catch(() => undefined);
      });

      throw err;
    }
  }
}
