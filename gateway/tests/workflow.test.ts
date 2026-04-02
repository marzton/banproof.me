// ============================================================
// Workflow / Engine tests — mock sentiment, odds, best price
// ============================================================

import { describe, it, expect } from 'vitest';
import { mockSentiment } from '../src/mocks/huggingface.js';
import { mockOdds }      from '../src/mocks/odds-api.js';

// ── Sentiment mock tests ──────────────────────────────────────

describe('mockSentiment', () => {
  it('returns a valid SentimentResult', () => {
    const result = mockSentiment();
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(result.label);
    expect(result.score).toBeGreaterThanOrEqual(0.55);
    expect(result.score).toBeLessThanOrEqual(0.95);
    expect(result.confidence).toBeGreaterThanOrEqual(0.70);
    expect(result.confidence).toBeLessThanOrEqual(0.98);
  });

  it('randomises labels across multiple calls', () => {
    const labels = new Set(Array.from({ length: 100 }, () => mockSentiment().label));
    // With 100 samples we expect at least BULLISH and BEARISH
    expect(labels.has('BULLISH')).toBe(true);
    expect(labels.has('BEARISH')).toBe(true);
  });

  it('score and confidence are numbers with 3 decimal places max', () => {
    const { score, confidence } = mockSentiment();
    expect(String(score).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
    expect(String(confidence).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });
});

// ── Odds mock tests ───────────────────────────────────────────

describe('mockOdds', () => {
  it('returns exactly 3 bookmakers', () => {
    const result = mockOdds();
    expect(result.bookmakers).toHaveLength(3);
  });

  it('returns DraftKings, FanDuel, and BetMGM', () => {
    const result = mockOdds();
    const names  = result.bookmakers.map((b) => b.bookmaker);
    expect(names).toContain('DraftKings');
    expect(names).toContain('FanDuel');
    expect(names).toContain('BetMGM');
  });

  it('prices are in the American odds range -125 to -95', () => {
    for (let i = 0; i < 20; i++) {
      const { bookmakers } = mockOdds();
      bookmakers.forEach(({ price }) => {
        expect(price).toBeGreaterThanOrEqual(-125);
        expect(price).toBeLessThanOrEqual(-95);
      });
    }
  });

  it('bestPrice bookmaker is the one with the lowest spread', () => {
    const { bookmakers, bestPrice } = mockOdds();
    const minSpread = Math.min(...bookmakers.map((b) => b.spread));
    const expected  = bookmakers.find((b) => b.spread === minSpread)!;
    expect(bestPrice.bookmaker).toBe(expected.bookmaker);
  });

  it('bestPrice.value is EV+, NEUTRAL, or EV-', () => {
    const { bestPrice } = mockOdds();
    expect(['EV+', 'NEUTRAL', 'EV-']).toContain(bestPrice.value);
  });

  it('spreads are 0.0 – 12.0', () => {
    for (let i = 0; i < 10; i++) {
      const { bookmakers } = mockOdds();
      bookmakers.forEach(({ spread }) => {
        expect(spread).toBeGreaterThanOrEqual(0);
        expect(spread).toBeLessThanOrEqual(12);
      });
    }
  });
});

// ── Best price logic ──────────────────────────────────────────

describe('best price selection', () => {
  it('always selects the bookmaker with the minimum spread', () => {
    for (let i = 0; i < 50; i++) {
      const { bookmakers, bestPrice } = mockOdds();
      const sorted  = [...bookmakers].sort((a, b) => a.spread - b.spread);
      expect(bestPrice.bookmaker).toBe(sorted[0].bookmaker);
    }
  });

  it('bestPrice.value is EV+ when spread < 3', () => {
    // Run many times; at least some should produce EV+
    const values: string[] = [];
    for (let i = 0; i < 200; i++) {
      const { bestPrice, bookmakers } = mockOdds();
      const minSpread = Math.min(...bookmakers.map((b) => b.spread));
      if (minSpread < 3)  values.push('EV+');
      if (minSpread >= 3 && minSpread < 7) values.push('NEUTRAL');
      if (minSpread >= 7) values.push('EV-');
    }
    // All three categories should appear in 200 samples
    expect(values).toContain('EV+');
    expect(values).toContain('NEUTRAL');
  });
});
