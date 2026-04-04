// ============================================================
// Mock Hugging Face SportsBERT sentiment analyzer
// Returns randomized BULLISH/BEARISH scores for sandbox testing
// ============================================================

import type { SentimentResult } from '../types/api.js';

export function mockSentiment(): SentimentResult {
  const isBullish = Math.random() > 0.5;
  const score = parseFloat((Math.random() * 0.45 + 0.55).toFixed(3)); // 0.55–1.0

  // Confidence varies by label: BULLISH 0.80–0.95, BEARISH 0.50–0.70
  const confidence = parseFloat(
    (isBullish
      ? Math.random() * 0.15 + 0.8
      : Math.random() * 0.20 + 0.5
    ).toFixed(3)
  );

  return {
    score,
    label: isBullish ? 'BULLISH' : 'BEARISH',
    confidence,
    source: 'MOCK_HF',
  };
}
