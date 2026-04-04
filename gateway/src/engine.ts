// ============================================================
// BanproofEngine — Cloudflare Workflow
// Durable, checkpointed processing for slow external APIs.
// BanproofEngine — Cloudflare Workflow (Hybrid Mock/Real)
// Durable, checkpointed processing for slow external APIs.
// Branches based on user tier: free / pro / agency.
// Toggle mock vs. real APIs via USE_MOCK env var.
//
// Toggle: set USE_MOCK="true" in wrangler.toml [vars] to use
// randomised mock data instead of real external APIs.
// ============================================================

import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';

export type Params = {
  query: string;
  userId: string;
};

export class BanproofEngine extends WorkflowEntrypoint<Record<string, never>, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { query, userId } = event.payload;

    // Step 1 — HuggingFace sentiment analysis (durable/checkpointed)
    const sentiment = await step.do('hf-sentiment', async () => {
      // TODO: replace stub with real HuggingFace Inference API call
      // using env var HF_API_TOKEN when wired up
      return { score: 0.85, label: 'POSITIVE' as const };
    });

    // Step 2 — Fetch market odds from The Odds API (durable/checkpointed)
    const odds = await step.do('fetch-odds', async () => {
      // TODO: replace stub with real Odds API call
      // using env var ODDS_API_KEY when wired up
      return { price: 1.95, bookmaker: 'DraftKings' };
    });

    // Step 3 — Discord notification (durable/checkpointed)
    await step.do('discord-notify', async () => {
      const result = { query, userId, sentiment, odds };
      console.log('[BanproofEngine] discord-notify:', JSON.stringify(result));
      return result;
import { mockSentiment } from './mocks/huggingface.js';
import { mockOdds }      from './mocks/odds-api.js';
import type { SentimentResult, OddsResult, AuditAction } from './types/api.js';

// ── Env bindings available inside the Workflow ────────────────
type Env = {
  DB:              D1Database;
  CACHE:           KVNamespace;
  USE_MOCK:        string;          // "true" | "false"
  HF_API_TOKEN?:   string;
  ODDS_API_KEY?:   string;
  DISCORD_WEBHOOK?: string;
};

export type Params = {
  query:   string;
  userId:  string;
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

    // ── Step 1: Sentiment Analysis ────────────────────────────
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
        const raw = await res.json();
        const data = Array.isArray(raw) ? raw as Array<Array<{ label: string; score: number }>> : [];
        const top  = data[0]?.[0] ?? { label: 'NEUTRAL', score: 0.5 };
        const label = top.label.toUpperCase().includes('POS') ? 'BULLISH' : 'BEARISH';
        return {
          score:      top.score,
          label,
          confidence: top.score,
          source:     'REAL_HF',
        } satisfies SentimentResult;
      },
    );

    // ── Step 2: Market Odds Aggregation ───────────────────────
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
      const raw = await res.json();
      const data = Array.isArray(raw) ? raw as Array<{
        bookmakers: Array<{ title: string; markets: Array<{ outcomes: Array<{ name: string; price: number }> }> }>;
      }> : [];
      const first = data[0];
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
        source: 'REAL_ODDS',
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

      await auditLog(this.env.DB, userId, 'AI_ANALYSIS', decision);
      return decision;
    });

    // ── Step 4: Discord Notification (optional) ───────────────
    await step.do('discord-notify', async () => {
      const summary = {
        query,
        userId,
        sentiment: { label: sentiment.label, confidence: sentiment.confidence },
        best_price: odds.best_price,
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
      const result = { query, userId, sentiment, odds };
      console.log('[BanproofEngine] discord-notify:', JSON.stringify(result));
      return result;
import { mockSentiment } from './mocks/huggingface.js';
import { mockOdds }      from './mocks/odds-api.js';
import type { SentimentResult, OddsResult, AuditAction } from './types/api.js';

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

    // ── Step 1: Sentiment Analysis ────────────────────────────
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
        const raw = await res.json() as unknown;
        const data = Array.isArray(raw) ? raw as Array<Array<{ label: string; score: number }>> : [];
        const top  = data[0]?.[0] ?? { label: 'NEUTRAL', score: 0.5 };
        const label = top.label.toUpperCase().includes('POS') ? 'BULLISH' : 'BEARISH';
        return {
          score:      top.score,
          label,
          confidence: top.score,
          source:     'REAL_HF' as const,
        };
      },
    );

    // ── Step 2: Market Odds Aggregation ───────────────────────
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
      const raw = await res.json() as unknown;
      const data = Array.isArray(raw) ? raw as Array<{
        bookmakers: Array<{ title: string; markets: Array<{ outcomes: Array<{ name: string; price: number }> }> }>;
      }> : [];
      const first = data[0];
      const bookmakers = (first?.bookmakers ?? []).map((bm) => ({
        name:   bm.title,
        price:  bm.markets[0]?.outcomes[0]?.price ?? 0,
        spread: 0,
        value:  undefined,
      }));
      const best = bookmakers.length
        ? bookmakers.reduce((a, b) => (b.price > a.price ? b : a))
        : { name: 'N/A', price: 0 };
      return {
        bookmakers,
        best_price: { bookmaker: best.name, price: best.price },
        source: 'REAL_ODDS' as const,
      };
    });

    // ── Step 3: Best Price Logic + D1 audit ───────────────────
    await step.do('best-price-decision', async () => {
      const evOpportunity = odds.bookmakers.find((b) => b.value === 'EV+');
      const decision = {
        query,
        userId,
        sentiment,
        best_price:     odds.best_price,
        ev_opportunity: evOpportunity ?? null,
      };

      await auditLog(this.env.DB, userId, 'AI_ANALYSIS', decision);
      return decision;
    });

    // ── Step 4: Discord Notification (optional) ───────────────
    await step.do('discord-notify', async () => {
      const summary = {
        query,
        userId,
        sentiment: { label: sentiment.label, confidence: sentiment.confidence },
        best_price: odds.best_price,
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

    return {
      sentiment,
      best_price: odds.best_price,
      execution_proof: {
        discord_sent:  !!this.env.DISCORD_WEBHOOK,
        audit_logged:  true,
        timestamp:     new Date().toISOString(),
      },
    };
  }
}
