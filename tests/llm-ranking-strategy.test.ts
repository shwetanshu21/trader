// ── LlmRankingStrategy tests ──
// Proves that the plugin:
//   - Correctly implements the StrategyPlugin interface
//   - Ranks candidates deterministically when LLM is unavailable
//   - Scores based on volume, spread, and price availability
//   - Returns empty array for empty input
//   - Produces deterministic ordering
//   - evaluateAsync returns explicit LLM status evidence (Consulted/Degraded/Error/Skipped)
//   - evaluateAsync falls back to deterministic when LLM call fails (with Degraded/Error status)
//   - evaluateAsync uses LLM results when provider returns rankings (with Consulted status)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  type BoundedCandidate,
  type RankedCandidate,
  type ProposalEngineConfig,
  LLMStatus,
} from '../src/types/runtime.js';
import { ProposalEngine } from '../src/proposals/proposal-engine.js';
import {
  LlmRankingStrategy,
  type LlmEvaluationResult,
} from '../src/strategy/llm-ranking-strategy.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides?: Partial<BoundedCandidate>): BoundedCandidate {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 12345,
    side: 'buy',
    lastPrice: 2500.50,
    bid: 2500.00,
    ask: 2501.00,
    volume: 1_000_000,
    instrumentType: 'EQ',
    lotSize: 1,
    tickSize: 0.05,
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<ProposalEngineConfig>): ProposalEngineConfig {
  return {
    providerMode: 'custom',
    providerUrl: 'https://api.example.com/proposals',
    timeoutMs: 5000,
    maxProposalsPerTick: 5,
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LlmRankingStrategy', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('plugin identity', () => {
    it('has the correct identity', () => {
      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      expect(plugin.identity.id).toBe('llm-ranking-v1');
      expect(plugin.identity.name).toBe('LLM Ranking Strategy');
      expect(plugin.identity.version).toBe('1.0.0');
    });
  });

  describe('empty input', () => {
    it('returns empty array when no candidates provided', () => {
      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const results = plugin.evaluate([]);
      expect(results).toEqual([]);
    });

    it('evaluateAsync returns Skipped status for empty candidates', async () => {
      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const result = await plugin.evaluateAsync([]);
      expect(result.rankings).toEqual([]);
      expect(result.llmStatus).toBe(LLMStatus.Skipped);
      expect(result.llmScore).toBeNull();
      expect(result.llmRationale).toBe('No candidates to evaluate');
    });
  });

  describe('deterministic scoring', () => {
    it('scores candidates based on volume', () => {
      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'HIGH_VOL', volume: 10_000_000 }),
        makeCandidate({ tradingsymbol: 'LOW_VOL', volume: 100 }),
      ];

      const results = plugin.evaluate(candidates);

      // Higher volume should rank first
      expect(results).toHaveLength(2);
      expect(results[0].candidate.tradingsymbol).toBe('HIGH_VOL');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('scores candidates with tight spreads higher', () => {
      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({
          tradingsymbol: 'TIGHT_SPREAD',
          bid: 100.00,
          ask: 100.01,
          volume: 1_000,
        }),
        makeCandidate({
          tradingsymbol: 'WIDE_SPREAD',
          bid: 100.00,
          ask: 110.00,
          volume: 1_000,
        }),
      ];

      const results = plugin.evaluate(candidates);

      // Tight spread should rank first
      expect(results[0].candidate.tradingsymbol).toBe('TIGHT_SPREAD');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('gives price bonus to candidates with lastPrice', () => {
      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({
          tradingsymbol: 'WITH_PRICE',
          lastPrice: 100.00,
          bid: null,
          ask: null,
          volume: 0,
        }),
        makeCandidate({
          tradingsymbol: 'NO_PRICE',
          lastPrice: null,
          bid: null,
          ask: null,
          volume: 0,
        }),
      ];

      const results = plugin.evaluate(candidates);

      // With-price should rank higher (price bonus)
      expect(results[0].candidate.tradingsymbol).toBe('WITH_PRICE');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('produces deterministic ordering given same inputs', () => {
      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS', volume: 500_000 }),
        makeCandidate({ tradingsymbol: 'INFY', volume: 300_000 }),
        makeCandidate({ tradingsymbol: 'RELIANCE', volume: 1_000_000 }),
      ];

      const result1 = plugin.evaluate(candidates);
      const result2 = plugin.evaluate(candidates);

      expect(result1).toHaveLength(result2.length);
      for (let i = 0; i < result1.length; i++) {
        expect(result1[i].candidate.tradingsymbol).toBe(result2[i].candidate.tradingsymbol);
        expect(result1[i].score).toBe(result2[i].score);
      }
    });

    it('sorts by score descending, then exchange, then symbol', () => {
      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      // All same volume and spread → same score → sorted by exchange then symbol
      const candidates = [
        makeCandidate({ exchange: 'NSE', tradingsymbol: 'ZOMATO', volume: 100_000 }),
        makeCandidate({ exchange: 'BSE', tradingsymbol: 'TCS', volume: 100_000 }),
        makeCandidate({ exchange: 'NSE', tradingsymbol: 'INFY', volume: 100_000 }),
      ];

      const results = plugin.evaluate(candidates);

      // BSE TCS < NSE INFY < NSE ZOMATO
      expect(results[0].candidate.exchange).toBe('BSE');
      expect(results[0].candidate.tradingsymbol).toBe('TCS');
      expect(results[1].candidate.tradingsymbol).toBe('INFY');
      expect(results[2].candidate.tradingsymbol).toBe('ZOMATO');
    });

    it('builds meaningful rationale', () => {
      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({
          tradingsymbol: 'TEST',
          volume: 500_000,
          bid: 100.00,
          ask: 100.50,
          lastPrice: 100.25,
        }),
      ];

      const results = plugin.evaluate(candidates);
      expect(results).toHaveLength(1);
      expect(results[0].rationale).toContain('Deterministic score');
      expect(results[0].rationale).toContain('vol=');
      expect(results[0].rationale).toContain('spread=');
      expect(results[0].rationale).toContain('last=');
    });
  });

  describe('evaluateAsync — explicit LLM status evidence', () => {
    it('returns Consulted status with LLM scores when provider succeeds', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          rankings: [
            {
              tradingsymbol: 'INFY',
              exchange: 'NSE',
              score: 0.9,
              rationale: 'Strong momentum',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS' }),
        makeCandidate({ tradingsymbol: 'INFY' }),
      ];

      const result = await plugin.evaluateAsync(candidates);

      expect(result.llmStatus).toBe(LLMStatus.Consulted);
      expect(result.llmScore).not.toBeNull();
      expect(result.llmRationale).toContain('LLM ranked');
      expect(result.rankings[0].candidate.tradingsymbol).toBe('INFY');
      expect(result.rankings[0].score).toBe(0.9);
    });

    it('returns Error status with deterministic fallback when LLM call throws', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network timeout'));

      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS', volume: 500_000 }),
        makeCandidate({ tradingsymbol: 'INFY', volume: 300_000 }),
      ];

      const result = await plugin.evaluateAsync(candidates);

      // Should indicate error and fall back to deterministic
      expect(result.llmStatus).toBe(LLMStatus.Error);
      expect(result.llmScore).toBeNull();
      expect(result.llmRationale).toContain('LLM provider error');
      expect(result.llmRationale).toContain('Network timeout');
      expect(result.rankings[0].candidate.tradingsymbol).toBe('TCS'); // Deterministic (higher vol)
      expect(result.rankings[0].rationale).toContain('Deterministic');
    });

    it('returns Degraded status with deterministic fallback when LLM returns empty', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ someUnexpectedField: 'value' }),
      );

      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS', volume: 500_000 }),
      ];

      const result = await plugin.evaluateAsync(candidates);

      // Should indicate degraded and fall back to deterministic
      expect(result.llmStatus).toBe(LLMStatus.Degraded);
      expect(result.llmScore).toBeNull();
      expect(result.llmRationale).toContain('empty rankings');
      expect(result.rankings).toHaveLength(1);
      expect(result.rankings[0].rationale).toContain('Deterministic');
    });

    it('returns Error status with deterministic fallback when provider returns 5xx', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Server Error', { status: 500 }),
      );

      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS', volume: 500_000 }),
      ];

      const result = await plugin.evaluateAsync(candidates);

      expect(result.llmStatus).toBe(LLMStatus.Error);
      expect(result.llmScore).toBeNull();
      expect(result.rankings).toHaveLength(1);
      expect(result.rankings[0].rationale).toContain('Deterministic');
    });
  });

  describe('evaluateAsync — with LLM rankings', () => {
    it('uses LLM rankings when provider returns valid rankings', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          rankings: [
            {
              tradingsymbol: 'INFY',
              exchange: 'NSE',
              score: 0.9,
              rationale: 'Strong momentum',
            },
            {
              tradingsymbol: 'TCS',
              exchange: 'NSE',
              score: 0.7,
              rationale: 'Stable but low volume',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS', volume: 100_000 }),
        makeCandidate({ tradingsymbol: 'INFY', volume: 200_000 }),
      ];

      const result = await plugin.evaluateAsync(candidates);

      // LLM says INFY > TCS
      expect(result.rankings).toHaveLength(2);
      expect(result.rankings[0].candidate.tradingsymbol).toBe('INFY');
      expect(result.rankings[0].score).toBe(0.9);
      expect(result.rankings[0].rationale).toBe('Strong momentum');
      expect(result.rankings[1].candidate.tradingsymbol).toBe('TCS');
      expect(result.rankings[1].score).toBe(0.7);
      expect(result.llmStatus).toBe(LLMStatus.Consulted);
    });

    it('falls back to deterministic for candidates not in LLM rankings', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          rankings: [
            {
              tradingsymbol: 'TCS',
              exchange: 'NSE',
              score: 0.95,
              rationale: 'Top pick',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS', volume: 500_000 }),
        makeCandidate({ tradingsymbol: 'INFY', volume: 100 }), // Not in LLM response
      ];

      const result = await plugin.evaluateAsync(candidates);

      // TCS has LLM score, INFY gets deterministic fallback
      expect(result.rankings).toHaveLength(2);
      expect(result.rankings[0].candidate.tradingsymbol).toBe('TCS');
      expect(result.rankings[0].score).toBe(0.95);

      expect(result.rankings[1].candidate.tradingsymbol).toBe('INFY');
      expect(result.rankings[1].rationale).toContain('Deterministic');
      expect(result.llmStatus).toBe(LLMStatus.Consulted);
    });

    it('uses proposals array as fallback when no rankings key', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          proposals: [
            {
              exchange: 'NSE',
              tradingsymbol: 'TCS',
              side: 'buy',
              product: 'MIS',
              quantity: 1,
              price: null,
              triggerPrice: null,
              orderType: 'MARKET',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS', volume: 500_000 }),
        makeCandidate({ tradingsymbol: 'INFY', volume: 100_000 }),
      ];

      const result = await plugin.evaluateAsync(candidates);

      // The proposal array maps to score 0.8 for TCS; INFY gets deterministic
      expect(result.rankings).toHaveLength(2);
      const tcs = result.rankings.find(r => r.candidate.tradingsymbol === 'TCS');
      expect(tcs).toBeDefined();
      expect(tcs!.score).toBe(0.8);
      expect(result.llmStatus).toBe(LLMStatus.Consulted);
    });

    it('clamps LLM scores to 0–1 range', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          rankings: [
            {
              tradingsymbol: 'TCS',
              exchange: 'NSE',
              score: 5.0, // Out of range
              rationale: 'Overflow',
            },
          ],
        }),
      );

      const engine = new ProposalEngine(makeConfig());
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS' }),
      ];

      const result = await plugin.evaluateAsync(candidates);

      expect(result.rankings).toHaveLength(1);
      expect(result.rankings[0].score).toBe(1.0); // Clamped to 1.0
      expect(result.llmStatus).toBe(LLMStatus.Consulted);
    });
  });

  describe('integration with ProposalEngine.sendRequest', () => {
    it('sends custom payload via sendRequest when providerMode is custom', async () => {
      let capturedUrl: string | null = null;
      let capturedBody: Record<string, unknown> | null = null;

      globalThis.fetch = vi.fn().mockImplementation(
        (url: string, options?: RequestInit) => {
          capturedUrl = url;
          capturedBody = JSON.parse(String(options?.body ?? '{}'));
          return Promise.resolve(jsonResponse({
            rankings: [
              {
                tradingsymbol: 'TCS',
                exchange: 'NSE',
                score: 0.85,
                rationale: 'Ranked by custom provider',
              },
            ],
          }));
        },
      );

      const engine = new ProposalEngine(makeConfig({
        providerMode: 'custom',
        providerUrl: 'https://custom.example.com/rank',
      }));
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS', volume: 500_000 }),
      ];

      const result = await plugin.evaluateAsync(candidates);

      expect(capturedUrl).toBe('https://custom.example.com/rank');
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!['version']).toBe('1.0');
      expect(capturedBody!['task']).toBe('rank_candidates');
      expect(capturedBody!['candidates']).toBeInstanceOf(Array);

      expect(result.rankings).toHaveLength(1);
      expect(result.rankings[0].score).toBe(0.85);
      expect(result.llmStatus).toBe(LLMStatus.Consulted);
    });

    it('sends OpenAI-compatible request via sendOpenAiRequest when providerMode is openai-compatible', async () => {
      let capturedUrl: string | null = null;
      let capturedBody: Record<string, unknown> | null = null;

      globalThis.fetch = vi.fn().mockImplementation(
        (url: string, options?: RequestInit) => {
          capturedUrl = url;
          capturedBody = JSON.parse(String(options?.body ?? '{}'));
          return Promise.resolve(jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rankings: [
                      {
                        tradingsymbol: 'TCS',
                        exchange: 'NSE',
                        score: 0.9,
                        rationale: 'Strong momentum in openai-compatible mode',
                      },
                    ],
                  }),
                },
              },
            ],
            usage: { total_tokens: 150 },
          }));
        },
      );

      const engine = new ProposalEngine(makeConfig({
        providerMode: 'openai-compatible',
        providerUrl: 'https://crof.ai/v1/chat/completions',
        providerModel: 'kimi-k2.6-precision',
      }));
      const plugin = new LlmRankingStrategy(engine);

      const candidates = [
        makeCandidate({ tradingsymbol: 'TCS', volume: 500_000 }),
      ];

      const result = await plugin.evaluateAsync(candidates);

      // Should hit the OpenAI-compatible endpoint
      expect(capturedUrl).toBe('https://crof.ai/v1/chat/completions');
      expect(capturedBody!['model']).toBe('kimi-k2.6-precision');
      expect(capturedBody!['messages']).toBeInstanceOf(Array);
      expect(capturedBody!['response_format']).toEqual({ type: 'json_object' });

      expect(result.rankings).toHaveLength(1);
      expect(result.rankings[0].score).toBe(0.9);
      expect(result.llmStatus).toBe(LLMStatus.Consulted);
    });
  });
});
