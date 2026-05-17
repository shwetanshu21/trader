import { loadConfig } from '../config/env.js';
import { ProposalEngine } from '../proposals/proposal-engine.js';

/**
 * Build an optional ProposalEngine from proposal-related env vars only.
 * This keeps walk-forward CLIs decoupled from unrelated runtime env settings
 * while still reusing the canonical config validation rules.
 */
export function createOptionalProposalEngine(
  env: Record<string, string | undefined> = process.env,
): ProposalEngine | undefined {
  const config = loadConfig({
    NODE_ENV: env.NODE_ENV,
    TRADER_PROPOSAL_PROVIDER_URL: env.TRADER_PROPOSAL_PROVIDER_URL,
    TRADER_PROPOSAL_PROVIDER_MODE: env.TRADER_PROPOSAL_PROVIDER_MODE,
    TRADER_PROPOSAL_PROVIDER_MODEL: env.TRADER_PROPOSAL_PROVIDER_MODEL,
    TRADER_PROPOSAL_API_KEY: env.TRADER_PROPOSAL_API_KEY,
    TRADER_PROPOSAL_TIMEOUT_MS: env.TRADER_PROPOSAL_TIMEOUT_MS,
    TRADER_PROPOSAL_MAX_PER_TICK: env.TRADER_PROPOSAL_MAX_PER_TICK,
  }).proposalEngine;

  return config ? new ProposalEngine(config) : undefined;
}
