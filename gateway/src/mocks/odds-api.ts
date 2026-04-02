// ============================================================
// Mock Odds API — 3 bookmakers with realistic spreads
// ============================================================

import type { OddsResult, BookmakerOdds } from '../types/api.js';

const BOOKMAKERS = ['DraftKings', 'FanDuel', 'BetMGM'] as const;

/** Spread in points — smaller is better value for the bettor. */
function randomSpread(): number {
  return parseFloat((Math.random() * 12).toFixed(1)); // 0.0 – 12.0
}

/** American odds centred around -110 with ± 15 variation. */
function randomPrice(): number {
  return -110 + Math.round((Math.random() - 0.5) * 30); // -125 to -95
}

export function mockOdds(): OddsResult {
  const bookmakers: BookmakerOdds[] = BOOKMAKERS.map((name) => ({
    bookmaker: name,
    price:     randomPrice(),
    spread:    randomSpread(),
  }));

  // Best price = lowest spread (closest to the market line)
  const sorted = [...bookmakers].sort((a, b) => a.spread - b.spread);
  const best   = sorted[0];

  return {
    bookmakers,
    bestPrice: {
      bookmaker: best.bookmaker,
      price:     best.price,
      value:     best.spread < 3 ? 'EV+' : best.spread < 7 ? 'NEUTRAL' : 'EV-',
    },
  };
}
