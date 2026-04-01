// ============================================================
// Banproof API — Shared TypeScript types
// ============================================================

export interface SentimentResult {
  score: number;
  label: 'BULLISH' | 'BEARISH';
  confidence: number;
  source: 'MOCK_HF' | 'REAL_HF';
}

export interface Bookmaker {
  name: string;
  price: number;
  spread: number;
  value?: 'EV+' | 'EV-' | 'FAIR';
}

export interface OddsResult {
  bookmakers: Bookmaker[];
  best_price: { bookmaker: string; price: number };
  source: 'MOCK_ODDS' | 'REAL_ODDS';
}

export interface WorkflowPayload {
  query: string;
  userId: string;
  useMock?: boolean;
}

export type AuditAction =
  | 'AI_ANALYSIS'
  | 'RATE_LIMIT_HIT'
  | 'WORKFLOW_START'
  | 'WORKFLOW_COMPLETE'
  | 'WORKFLOW_ERROR'
  | 'DISCORD_NOTIFY';
