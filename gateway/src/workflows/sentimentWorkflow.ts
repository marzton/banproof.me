import { mockSentiment } from '../mocks/huggingface.js';
import type { SentimentResult } from '../types/api.js';

type SentimentEnv = {
  USE_MOCK: string;
  HF_API_TOKEN?: string;
};

export interface SentimentExecutionResult {
  sentiment: SentimentResult;
  sourceMode: 'mock' | 'live';
}

export class SentimentWorkflow {
  constructor(private readonly env: SentimentEnv) {}

  async execute(query: string): Promise<SentimentExecutionResult> {
    const useMock = this.env.USE_MOCK !== 'false';

    if (useMock) {
      return {
        sentiment: mockSentiment(),
        sourceMode: 'mock',
      };
    }

    const res = await fetch(
      'https://api-inference.huggingface.co/models/cardiffnlp/twitter-roberta-base-sentiment-latest',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.HF_API_TOKEN ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: query }),
      },
    );

    if (!res.ok) {
      throw new Error(`HuggingFace API error: ${res.status} ${res.statusText}`);
    }

    const raw = await res.json() as Array<Array<{ label: string; score: number }>>;
    const top = raw[0]?.[0] ?? { label: 'NEUTRAL', score: 0.5 };
    const label = top.label.toUpperCase().includes('POS') ? 'BULLISH' : 'BEARISH';

    return {
      sentiment: {
        score: top.score,
        label,
        confidence: top.score,
        source: 'REAL_HF',
      },
      sourceMode: 'live',
    };
  }
}
