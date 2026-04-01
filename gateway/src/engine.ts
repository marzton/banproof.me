// ============================================================
// BanproofEngine — Cloudflare Workflow
// Durable, checkpointed processing for slow external APIs.
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
    });
  }
}
