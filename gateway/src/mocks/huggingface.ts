// ============================================================
// Mock Hugging Face SportsBERT sentiment analyzer
// Returns randomized BULLISH/BEARISH scores for sandbox testing
// ============================================================

import type { SentimentResult } from '../types/api.js';

export function mockSentiment(): SentimentResult {
  const isBullish = Math.random() > 0.5;
  const score = Math.random() * 0.5 + 0.5; // 0.5–1.0

  // Confidence varies by label: BULLISH 0.80–0.95, BEARISH 0.50–0.70
  const confidence = isBullish
    ? Math.random() * 0.15 + 0.8
    : Math.random() * 0.2 + 0.5;

  return {
    score,
    label: isBullish ? 'BULLISH' : 'BEARISH',
    confidence,
    source: 'MOCK_HF',
  };
}
