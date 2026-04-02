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
    expect(['BULLISH', 'BEARISH']).toContain(result.label);
    expect(result.score).toBeGreaterThanOrEqual(0.5);
    expect(result.score).toBeLessThanOrEqual(1.0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.confidence).toBeLessThanOrEqual(0.98);
    expect(result.source).toBe('MOCK_HF');
  });

  it('randomises labels across multiple calls', () => {
    const labels = new Set(Array.from({ length: 100 }, () => mockSentiment().label));
    // With 100 samples we expect at least BULLISH and BEARISH
    expect(labels.has('BULLISH')).toBe(true);
    expect(labels.has('BEARISH')).toBe(true);
  });
});

// ── Odds mock tests ───────────────────────────────────────────

describe('mockOdds', () => {
  it('returns at least 3 bookmakers', () => {
    const result = mockOdds();
    expect(result.bookmakers.length).toBeGreaterThanOrEqual(3);
  });

  it('returns DraftKings, FanDuel, and BetMGM', () => {
    const result = mockOdds();
    const names  = result.bookmakers.map((b) => b.name);
    expect(names).toContain('DraftKings');
    expect(names).toContain('FanDuel');
    expect(names).toContain('BetMGM');
  });

  it('best_price bookmaker has the highest price', () => {
    for (let i = 0; i < 10; i++) {
      const { bookmakers, best_price } = mockOdds();
      const maxPrice = Math.max(...bookmakers.map((b) => b.price));
      expect(best_price.price).toBe(maxPrice);
    }
  });

  it('best_price.value is EV+, EV-, or FAIR', () => {
    for (let i = 0; i < 10; i++) {
      const { bookmakers } = mockOdds();
      for (const bm of bookmakers) {
        expect(['EV+', 'EV-', 'FAIR']).toContain(bm.value);
      }
    }
  });

  it('returns source MOCK_ODDS', () => {
    expect(mockOdds().source).toBe('MOCK_ODDS');
  });
});

// ── Best price logic ──────────────────────────────────────────

describe('best price selection', () => {
  it('always selects the bookmaker with the highest price', () => {
    for (let i = 0; i < 50; i++) {
      const { bookmakers, best_price } = mockOdds();
      const maxPrice = Math.max(...bookmakers.map((b) => b.price));
      const expected = bookmakers.find((b) => b.price === maxPrice)!;
      expect(best_price.bookmaker).toBe(expected.name);
    }
  });

  it('EV+ classification applies when price > -108', () => {
    // Run many times to hit EV+ bookmakers
    let foundEV = false;
    for (let i = 0; i < 200; i++) {
      const { bookmakers } = mockOdds();
      for (const bm of bookmakers) {
        if (bm.price > -108) {
          expect(bm.value).toBe('EV+');
          foundEV = true;
        }
        if (bm.price < -115) expect(bm.value).toBe('EV-');
      }
    }
    // Statistically, at least one EV+ should appear in 200 runs
    expect(foundEV).toBe(true);
  });
});
