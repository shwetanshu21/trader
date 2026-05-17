import { describe, expect, it } from 'vitest';

import { ConfigValidationErrorImpl } from '../src/config/env.js';
import { ProposalEngine } from '../src/proposals/proposal-engine.js';
import { createOptionalProposalEngine } from '../src/replay/proposal-engine-factory.js';

describe('createOptionalProposalEngine', () => {
  it('returns undefined when proposal env vars are absent', () => {
    expect(createOptionalProposalEngine({})).toBeUndefined();
  });

  it('builds a ProposalEngine from valid custom-provider env vars', () => {
    const engine = createOptionalProposalEngine({
      TRADER_PROPOSAL_PROVIDER_URL: 'https://example.com/proposals',
      TRADER_PROPOSAL_TIMEOUT_MS: '45000',
      TRADER_PROPOSAL_MAX_PER_TICK: '7',
    });

    expect(engine).toBeInstanceOf(ProposalEngine);
  });

  it('requires a model for openai-compatible providers', () => {
    expect(() => createOptionalProposalEngine({
      TRADER_PROPOSAL_PROVIDER_URL: 'https://example.com/v1/chat/completions',
      TRADER_PROPOSAL_PROVIDER_MODE: 'openai-compatible',
    })).toThrow(ConfigValidationErrorImpl);
  });

  it('accepts openai-compatible provider config when model is present', () => {
    const engine = createOptionalProposalEngine({
      TRADER_PROPOSAL_PROVIDER_URL: 'https://example.com/v1/chat/completions',
      TRADER_PROPOSAL_PROVIDER_MODE: 'openai-compatible',
      TRADER_PROPOSAL_PROVIDER_MODEL: 'kimi-k2.6',
      TRADER_PROPOSAL_API_KEY: 'test-key',
    });

    expect(engine).toBeInstanceOf(ProposalEngine);
  });
});
