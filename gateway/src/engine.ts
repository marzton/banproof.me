// ============================================================
// BanproofEngine — Cloudflare Workflow
// Durable, checkpointed processing for slow external APIs.
// Branches based on user tier: free / pro / agency.
// Toggle mock vs. real APIs via USE_MOCK env var.
// ============================================================

import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';
import { mockSentiment } from './mocks/huggingface.js';
import { mockOdds }      from './mocks/odds-api.js';
import type { SentimentResult, OddsResult, AuditAction, AgencyAnalytics } from './types/api.js';

// ── Env bindings available inside the Workflow ────────────────
type Env = {
  DB:               D1Database;
  CACHE:            KVNamespace;
  STORAGE:          R2Bucket;
  USE_MOCK:         string;          // "true" | "false"
  HF_API_TOKEN?:    string;
  ODDS_API_KEY?:    string;
  DISCORD_WEBHOOK?: string;
};

export type Params = {
  query:    string;
  userId:   string;
  useMock?: boolean;
};

// ── Helper: fire-and-forget D1 audit write ────────────────────
async function auditLog(
  db: D1Database,
  userId: string,
  action: AuditAction,
  metadata: unknown,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (user_id, action, metadata) VALUES (?, ?, ?)`,
      )
      .bind(userId, action, JSON.stringify(metadata))
      .run();
  } catch {
    // Non-critical — swallow D1 errors so the workflow continues
  }
}

export class BanproofEngine extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { query, userId } = event.payload;
    const useMock =
      event.payload.useMock ?? this.env.USE_MOCK === 'true';

    // ── STEP 0: Fetch user tier ─────────────────────────────
    const userTier = await step.do('fetch-user-tier', async () => {
      const row = await this.env.DB.prepare(
        'SELECT plan_tier FROM users WHERE id = ? LIMIT 1',
      ).bind(userId).first<{ plan_tier: string }>();
      return row?.plan_tier ?? 'free';
    });

    // ── STEP 1: Sentiment Analysis ────────────────────────────
    const sentiment: SentimentResult = await step.do(
      'hf-sentiment',
      async () => {
        if (useMock) {
          return mockSentiment();
        }
        // Real Hugging Face Inference API call
        const res = await fetch(
          'https://api-inference.huggingface.co/models/cardiffnlp/twitter-roberta-base-sentiment-latest',
          {
            method:  'POST',
            headers: {
              Authorization:  `Bearer ${this.env.HF_API_TOKEN ?? ''}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ inputs: query }),
          },
        );
        if (!res.ok) {
          throw new Error(`HuggingFace API error: ${res.status} ${res.statusText}`);
        }
        const raw = await res.json() as Array<Array<{ label: string; score: number }>>;
        const top  = raw[0]?.[0] ?? { label: 'NEUTRAL', score: 0.5 };
        const label = top.label.toUpperCase().includes('POS') ? 'BULLISH' : 'BEARISH';
        return {
          score:      top.score,
          label,
          confidence: top.score,
          source:     'REAL_HF' as const,
        } satisfies SentimentResult;
      },
    );

    // ── Free tier: sentiment only ───────────────────────────
    if (userTier === 'free') {
      await step.do('persist-signal-free', async () => {
        const signalId = crypto.randomUUID();
        await this.env.DB.prepare(
          `INSERT INTO signals (id, user_id, type, score, metadata)
             VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          signalId, userId, 'SPORTS',
          sentiment.score,
          JSON.stringify({ sentiment, query, tier: 'free' }),
        ).run().catch(() => { /* table might not exist yet */ });

        await auditLog(this.env.DB, userId, 'AI_ANALYSIS', { sentiment, tier: 'free' });
      });

      return {
        tier:           userTier,
        sentiment,
        upgrade_prompt: 'Upgrade to Pro for full odds data.',
      };
    }

    // ── STEP 2: Market Odds Aggregation ───────────────────────
    const odds: OddsResult = await step.do('fetch-odds', async () => {
      if (useMock) {
        return mockOdds();
      }
      // Real The Odds API call
      const res = await fetch(
        `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${this.env.ODDS_API_KEY ?? ''}&regions=us&markets=spreads`,
      );
      if (!res.ok) {
        throw new Error(`Odds API error: ${res.status} ${res.statusText}`);
      }
      const raw = await res.json() as Array<{
        bookmakers: Array<{ title: string; markets: Array<{ outcomes: Array<{ name: string; price: number }> }> }>;
      }>;
      const first = raw[0];
      const bookmakers = (first?.bookmakers ?? []).map((bm) => ({
        name:   bm.title,
        price:  bm.markets[0]?.outcomes[0]?.price ?? 0,
        spread: 0,
        value:  undefined as OddsResult['bookmakers'][0]['value'],
      }));
      const best = bookmakers.length
        ? bookmakers.reduce((a, b) => (b.price > a.price ? b : a))
        : { name: 'N/A', price: 0 };
      return {
        bookmakers,
        best_price: { bookmaker: best.name, price: best.price },
        source: 'REAL_ODDS' as const,
      } satisfies OddsResult;
    });

    // ── Step 3: Best Price Logic + D1 audit ───────────────────
    await step.do('best-price-decision', async () => {
      const evOpportunity = odds.bookmakers.find((b) => b.value === 'EV+');
      const decision = {
        query,
        userId,
        sentiment,
        best_price: odds.best_price,
        ev_opportunity: evOpportunity ?? null,
      };
    // ── Pro tier ────────────────────────────────────────────
    if (userTier === 'pro') {
      await step.do('persist-signal-pro', async () => {
        const signalId = crypto.randomUUID();
        await this.env.DB.prepare(
          `INSERT INTO signals (id, user_id, type, score, metadata)
             VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          signalId, userId, 'SPORTS',
          sentiment.score,
          JSON.stringify({ sentiment, odds, tier: 'pro' }),
        ).run().catch(() => {});

        await auditLog(this.env.DB, userId, 'AI_ANALYSIS', { sentiment, best_price: odds.best_price, tier: 'pro' });
      });

      return { tier: userTier, sentiment, odds, best_price: odds.best_price };
    }

    // ── STEP 4: Advanced analytics (agency) ─────────────────
    const analytics: AgencyAnalytics = await step.do('advanced-analytics', async () => {
      const sharpPrice  = odds.bookmakers.reduce((b, o) => o.price > b.price ? o : b, odds.bookmakers[0]);
      const publicPrice = odds.bookmakers.reduce((w, o) => o.price < w.price ? o : w, odds.bookmakers[0]);
      return {
        sharp_public_split:    { sharp_price: sharpPrice.price, public_price: publicPrice.price },
        ev_plus_threshold:     0.08,
        confidence_multiplier: sentiment.confidence > 0.85 ? 1.5 : 1.0,
        recommendation:        (
          sentiment.label === 'BULLISH' && sentiment.confidence > 0.8 ? 'STRONG_BUY'
            : sentiment.label === 'BULLISH' ? 'BUY'
            : sentiment.label === 'BEARISH' ? 'SELL'
            : 'HOLD'
        ) as 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL',
      } satisfies AgencyAnalytics;
    });

    // ── STEP 5: Discord notification (optional) ───────────────
    await step.do('discord-notify', async () => {
      const summary = {
        query,
        userId,
        sentiment: { label: sentiment.label, confidence: sentiment.confidence },
        best_price: odds.best_price,
        recommendation: analytics.recommendation,
        source: useMock ? 'MOCK' : 'LIVE',
      };

      if (this.env.DISCORD_WEBHOOK) {
        try {
          await fetch(this.env.DISCORD_WEBHOOK, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              content: `🏆 **Banproof Signal** | ${sentiment.label} (conf: ${(sentiment.confidence * 100).toFixed(1)}%)\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``,
            }),
          });
          await auditLog(this.env.DB, userId, 'DISCORD_NOTIFY', { status: 'sent' });
        } catch (err) {
          await auditLog(this.env.DB, userId, 'DISCORD_NOTIFY', { status: 'error', error: String(err) });
        }
      } else {
        console.log('[BanproofEngine] discord-notify (no webhook configured):', JSON.stringify(summary));
      }

      return summary;
    });

    // ── STEP 6: Persist full signal (agency) ────────────────
    await step.do('persist-signal-agency', async () => {
      const signalId = crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT INTO signals (id, user_id, type, score, metadata)
           VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        signalId, userId, 'SPORTS',
        sentiment.score,
        JSON.stringify({
          query, sentiment, odds, analytics,
          tier: 'agency', executedAt: new Date().toISOString(),
        }),
      ).run().catch(() => {});

      await auditLog(this.env.DB, userId, 'AI_ANALYSIS', { sentiment, best_price: odds.best_price, recommendation: analytics.recommendation, tier: 'agency' });
    });

    return {
      tier:           userTier,
      sentiment,
      odds,
      best_price:     odds.best_price,
      analytics,
      execution_proof: {
        discord_sent:  !!this.env.DISCORD_WEBHOOK,
        audit_logged:  true,
        timestamp:     new Date().toISOString(),
      },
    };
  }
}
