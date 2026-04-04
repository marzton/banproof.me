// ============================================================
// Mock The Odds API — 3+ bookmakers with realistic spreads
// ============================================================

import type { OddsResult, Bookmaker } from '../types/api.js';

const BASE_BOOKMAKERS: Array<Omit<Bookmaker, 'value'>> = [
  { name: 'DraftKings', price: -110, spread: -1.5 },
  { name: 'FanDuel',    price: -115, spread: -1.5 },
  { name: 'BetMGM',     price: -108, spread: -1.5 },
  { name: 'Caesars',    price: -112, spread: -1.5 },
];

function jitter(base: number): number {
  // ±5 point variance to simulate live market movement
  return base + Math.floor(Math.random() * 11) - 5;
}

function classifyValue(price: number): Bookmaker['value'] {
  if (price > -108) return 'EV+';
  if (price < -115) return 'EV-';
  return 'FAIR';
}

export function mockOdds(): OddsResult {
  const bookmakers: Bookmaker[] = BASE_BOOKMAKERS.map((bm) => {
    const price = jitter(bm.price);
    return { ...bm, price, value: classifyValue(price) };
  });

  // Best price = highest (least negative) price = most favorable for bettor
  const best = bookmakers.reduce((prev, curr) =>
    curr.price > prev.price ? curr : prev,
  );

  return {
    bookmakers,
    best_price: { bookmaker: best.name, price: best.price },
    source: 'MOCK_ODDS',
  };
}
