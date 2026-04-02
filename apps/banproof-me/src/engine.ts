// ============================================================
// Banproof Signal Engine — apps/banproof-me/src/engine.ts
//
// Detangled from the gateway root.
// Signal results write to the signals table (not audit_log).
// DB types sourced from @goldshore/database.
// ============================================================

import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';
import type { PlanTier, SignalType } from '../../packages/database/src/types.js';

// ── Inline mock helpers (no external mock dep in apps/) ────────

type SentimentLabel = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

interface SentimentResult {
  label:      SentimentLabel;
  score:      number;
  confidence: number;
}

interface BookmakerOdds {
  bookmaker: string;
  price:     number;
  spread:    number;
}

function _mockSentiment(): SentimentResult {
  const roll = Math.random();
  const label: SentimentLabel = roll < 0.50 ? 'BULLISH' : roll < 0.85 ? 'BEARISH' : 'NEUTRAL';
  return {
    label,
    score:      parseFloat((0.55 + Math.random() * 0.40).toFixed(3)),
    confidence: parseFloat((0.70 + Math.random() * 0.28).toFixed(3)),
  };
}

function _mockOdds(): BookmakerOdds[] {
  return (['DraftKings', 'FanDuel', 'BetMGM'] as const).map((name) => ({
    bookmaker: name,
    price:     -110 + Math.round((Math.random() - 0.5) * 30),
    spread:    parseFloat((Math.random() * 12).toFixed(1)),
  }));
}

// ── Engine types ───────────────────────────────────────────────

export type Params = {
  query:      string;
  userId:     string;
  signalType: SignalType;
};

type Env = {
  DB:             D1Database;
  CACHE:          KVNamespace;
  USE_MOCK:       string;
  HF_API_TOKEN?:  string;
  ODDS_API_KEY?:  string;
  DISCORD_WEBHOOK?: string;
};

// ── BanproofEngine ─────────────────────────────────────────────

export class BanproofEngine extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { query, userId, signalType = 'SPORTS' } = event.payload;
    const isMock = this.env.USE_MOCK !== 'false';

    // ── STEP 0: Fetch user tier ─────────────────────────────
    const userTier = await step.do('fetch-user-tier', async () => {
      const row = await this.env.DB.prepare(
        'SELECT plan_tier FROM users WHERE id = ? LIMIT 1',
      ).bind(userId).first<{ plan_tier: PlanTier }>();
      return (row?.plan_tier ?? 'free') as PlanTier;
    });

    // ── STEP 1: Sentiment (all tiers) ──────────────────────
    const sentiment: SentimentResult = await step.do('sentiment-analysis', async () => {
      if (isMock) return _mockSentiment();

      const res = await fetch(
        'https://api-inference.huggingface.co/models/cardiffnlp/twitter-roberta-base-sentiment-latest',
        {
          method:  'POST',
          headers: {
            Authorization: `Bearer ${this.env.HF_API_TOKEN ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inputs: query }),
        },
      );
      if (!res.ok) throw new Error(`HuggingFace API error: ${res.status}`);
      const json = await res.json<Array<Array<{ label: string; score: number }>>>();
      const top  = json[0]?.sort((a, b) => b.score - a.score)[0];
      return {
        label:      (top?.label?.toUpperCase() ?? 'NEUTRAL') as SentimentLabel,
        score:      top?.score ?? 0.5,
        confidence: top?.score ?? 0.5,
      };
    });

    // ── Free tier: sentiment only ───────────────────────────
    if (userTier === 'free') {
      await step.do('persist-signal-free', async () => {
        const signalId = crypto.randomUUID();
        await this.env.DB.prepare(
          `INSERT INTO signals (id, user_id, type, score, metadata)
             VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          signalId, userId, signalType,
          sentiment.score,
          JSON.stringify({ sentiment, query, tier: 'free' }),
        ).run();
      });

      return {
        tier:           userTier,
        sentiment,
        upgrade_prompt: 'Upgrade to Pro for full odds data.',
      };
    }

    // ── STEP 2: Odds aggregation (pro + agency) ─────────────
    const odds: BookmakerOdds[] = await step.do('odds-aggregation', async () => {
      if (isMock) return _mockOdds();

      const res = await fetch(
        `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${this.env.ODDS_API_KEY ?? ''}&markets=h2h&oddsFormat=american`,
      );
      if (!res.ok) throw new Error(`Odds API error: ${res.status}`);
      const json = await res.json<any[]>();
      return (json[0]?.bookmakers ?? []).slice(0, 3).map((bm: any) => ({
        bookmaker: bm.title,
        price:     bm.markets?.[0]?.outcomes?.[0]?.price ?? -110,
        spread:    0,
      }));
    });

    const sorted    = [...odds].sort((a, b) => a.spread - b.spread);
    const bestPrice = {
      bookmaker: sorted[0]?.bookmaker ?? 'Unknown',
      price:     sorted[0]?.price     ?? -110,
      value:     (sorted[0]?.spread < 3 ? 'EV+' : sorted[0]?.spread < 7 ? 'NEUTRAL' : 'EV-') as 'EV+' | 'NEUTRAL' | 'EV-',
    };

    // ── Pro tier ────────────────────────────────────────────
    if (userTier === 'pro') {
      await step.do('persist-signal-pro', async () => {
        const signalId = crypto.randomUUID();
        await this.env.DB.prepare(
          `INSERT INTO signals (id, user_id, type, score, metadata)
             VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          signalId, userId, signalType,
          sentiment.score,
          JSON.stringify({ sentiment, odds, bestPrice, tier: 'pro' }),
        ).run();
      });

      return { tier: userTier, sentiment, odds, best_price: bestPrice };
    }

    // ── STEP 4: Advanced analytics (agency) ─────────────────
    const analytics = await step.do('advanced-analytics', async () => {
      const sharpPrice  = odds.reduce((b, o) => o.price > b.price ? o : b, odds[0]);
      const publicPrice = odds.reduce((w, o) => o.price < w.price ? o : w, odds[0]);
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
      };
    });

    // ── STEP 5: Discord notification ────────────────────────
    await step.do('discord-notify', async () => {
      if (!this.env.DISCORD_WEBHOOK) {
        console.log('[Agency] Discord webhook not configured — skipping.');
        return;
      }
      const colour = sentiment.label === 'BULLISH' ? 0x00ff00 : 0xff0000;
      await fetch(this.env.DISCORD_WEBHOOK, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          content: `🎯 Agency Signal (${signalType}) — user ${userId}`,
          embeds:  [{
            title:       `${sentiment.label} Signal`,
            description: `Score: ${(sentiment.score * 100).toFixed(1)}% | Best: ${bestPrice.bookmaker} @ ${bestPrice.price}`,
            color:       colour,
            fields:      [
              { name: 'Sharp/Public Split', value: `Sharp: ${analytics.sharp_public_split.sharp_price} | Public: ${analytics.sharp_public_split.public_price}`, inline: true },
              { name: 'Recommendation',     value: analytics.recommendation, inline: true },
            ],
          }],
        }),
      });
    });

    // ── STEP 6: Persist full signal (agency) ────────────────
    await step.do('persist-signal-agency', async () => {
      const signalId = crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT INTO signals (id, user_id, type, score, metadata)
           VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        signalId, userId, signalType,
        sentiment.score,
        JSON.stringify({
          query, sentiment, odds, bestPrice, analytics,
          tier: 'agency', executedAt: new Date().toISOString(),
        }),
      ).run();
    });

    return {
      tier:           userTier,
      sentiment,
      odds,
      best_price:     bestPrice,
      analytics,
      execution_proof: {
        discord_sent:  !!this.env.DISCORD_WEBHOOK,
        signal_logged: true,
        timestamp:     new Date().toISOString(),
      },
    };
  }
}
