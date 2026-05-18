import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  type BoundedCandidate,
  type RankedCandidate,
  type StrategyPlugin,
  type StrategyPluginIdentity,
  type StrategyFrameworkConfig,
  type CoordinatorResult,
  LLMStatus,
  MergePolicy,
  type HybridCoordinatorResult,
  type HybridCandidateEvidence,
} from '../src/types/runtime.js';
import {
  StrategyCoordinator,
  DEFAULT_FRAMEWORK_CONFIG,
} from '../src/strategy/framework.js';
import type { LlmEvaluationResult } from '../src/strategy/llm-ranking-strategy.js';

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

function makePlugin(
  id: string,
  name: string,
  version: string,
  scorer: (c: BoundedCandidate) => number = () => 0.5,
  rationaleFn: (c: BoundedCandidate) => string = () => 'Default rationale',
): StrategyPlugin {
  return {
    identity: { id, name, version },
    evaluate(candidates: BoundedCandidate[]): RankedCandidate[] {
      return candidates.map(c => ({
        candidate: c,
        plugin: { id, name, version },
        score: scorer(c),
        rationale: rationaleFn(c),
      }));
    },
  };
}

function makeAlphaCandidate(
  tradingsymbol: string,
  overrides?: Partial<BoundedCandidate>,
): BoundedCandidate {
  return makeCandidate({ tradingsymbol, ...overrides });
}

/** Create an async-capable mock plugin that mimics LlmRankingStrategy. */
function makeAsyncPlugin(
  id: string,
  name: string,
  version: string,
  scorer: (c: BoundedCandidate) => number = () => 0.5,
  asyncResult?: LlmEvaluationResult,
): StrategyPlugin & { evaluateAsync: (candidates: BoundedCandidate[]) => Promise<LlmEvaluationResult> } {
  return {
    identity: { id, name, version },
    evaluate(candidates: BoundedCandidate[]): RankedCandidate[] {
      return candidates.map(c => ({
        candidate: c,
        plugin: { id, name, version },
        score: scorer(c),
        rationale: 'Sync deterministic score',
      }));
    },
    async evaluateAsync(_candidates: BoundedCandidate[]): Promise<LlmEvaluationResult> {
      return asyncResult ?? {
        rankings: [],
        llmStatus: LLMStatus.Skipped,
        llmScore: null,
        llmRationale: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin contract sanity
// ---------------------------------------------------------------------------

describe('StrategyPlugin contract', () => {
  it('plugin returns ranked candidates for each input', () => {
    const plugin = makePlugin('test-v1', 'Test Plugin', '1.0.0', () => 1.0);
    const candidates = [
      makeAlphaCandidate('TCS'),
      makeAlphaCandidate('INFY'),
    ];
    const results = plugin.evaluate(candidates);
    expect(results).toHaveLength(2);
    results.forEach((r, i) => {
      expect(r.candidate.tradingsymbol).toBe(candidates[i].tradingsymbol);
      expect(r.score).toBe(1.0);
      expect(r.plugin.id).toBe('test-v1');
      expect(r.rationale).toBeTruthy();
    });
  });

  it('plugin returns empty array when no candidates match criteria', () => {
    const emptyPlugin: StrategyPlugin = {
      identity: { id: 'empty-v1', name: 'Empty Matcher', version: '1.0.0' },
      evaluate: () => [],
    };
    const results = emptyPlugin.evaluate([makeCandidate()]);
    expect(results).toEqual([]);
  });

  it('plugin identity is immutable at the type level', () => {
    const plugin = makePlugin('id-v1', 'Name', '1.0.0');
    expect(plugin.identity.id).toBe('id-v1');
    expect(plugin.identity.name).toBe('Name');
    expect(plugin.identity.version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// StrategyCoordinator — grouped hybrid evidence
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — grouped hybrid evidence', () => {
  it('returns one HybridCandidateEvidence per candidate when single plugin used', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0', () => 0.5);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 5 });

    const candidates = [
      makeAlphaCandidate('TCS'),
      makeAlphaCandidate('INFY'),
    ];

    const result = await coordinator.evaluate(candidates);
    expect(result.candidates).toHaveLength(2);
    // Both have same score (0.5), same plugin → sort by exchange then symbol alphabetically
    // INFY < TCS alphabetically
    expect(result.candidates[0].candidate.tradingsymbol).toBe('INFY');
    expect(result.candidates[1].candidate.tradingsymbol).toBe('TCS');
    expect(result.candidates[0].candidateKey).toBe('NSE:INFY');
    expect(result.candidates[1].candidateKey).toBe('NSE:TCS');
  });

  it('groups same candidate from multiple plugins into one evidence record', async () => {
    const pluginA = makePlugin('a-v1', 'A', '1.0.0', () => 0.6);
    const pluginB = makePlugin('b-v1', 'B', '1.0.0', () => 0.9);
    const coordinator = new StrategyCoordinator([pluginA, pluginB], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];

    const result = await coordinator.evaluate(candidates);
    // 1 candidate, 2 plugins → 1 grouped evidence record with 2 plugin scores
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].pluginScores).toHaveLength(2);
    expect(result.candidates[0].pluginScores[0].plugin.id).toBe('a-v1');
    expect(result.candidates[0].pluginScores[1].plugin.id).toBe('b-v1');
    // deterministicScore = average of (0.6, 0.9) = 0.75
    expect(result.candidates[0].deterministicScore).toBe(0.75);
  });

  it('deterministicScore is average of all plugin scores per candidate', async () => {
    const pluginA = makePlugin('a-v1', 'A', '1.0.0', c =>
      c.tradingsymbol === 'TCS' ? 0.9 : 0.1,
    );
    const pluginB = makePlugin('b-v1', 'B', '1.0.0', c =>
      c.tradingsymbol === 'INFY' ? 0.8 : 0.2,
    );
    const coordinator = new StrategyCoordinator([pluginA, pluginB], { maxCandidates: 10 });

    const candidates = [
      makeAlphaCandidate('TCS'),
      makeAlphaCandidate('INFY'),
    ];

    const result = await coordinator.evaluate(candidates);

    // TCS: pluginA=0.9, pluginB=0.2 → det=0.55
    const tcs = result.candidates.find(c => c.candidate.tradingsymbol === 'TCS')!;
    expect(tcs.deterministicScore).toBeCloseTo((0.9 + 0.2) / 2, 5);

    // INFY: pluginA=0.1, pluginB=0.8 → det=0.45
    const infy = result.candidates.find(c => c.candidate.tradingsymbol === 'INFY')!;
    expect(infy.deterministicScore).toBeCloseTo((0.1 + 0.8) / 2, 5);
  });

  it('mergedScore equals deterministicScore when no LLM plugin (DeterministicOnly)', async () => {
    const plugin = makePlugin('det-v1', 'Deterministic', '1.0.0', () => 0.7);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates);

    expect(result.candidates[0].deterministicScore).toBe(0.7);
    expect(result.candidates[0].mergedScore).toBe(0.7);
    expect(result.candidates[0].mergePolicy).toBe(MergePolicy.DeterministicOnly);
    expect(result.candidates[0].llmStatus).toBe(LLMStatus.Skipped);
    expect(result.candidates[0].llmScore).toBeNull();
  });

  it('produces deterministic ordering by mergedScore then exchange then symbol', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0', () => 1.0);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 10 });

    const candidates = [
      makeAlphaCandidate('ZOMATO'),
      makeAlphaCandidate('TCS', { exchange: 'BSE' }),
      makeAlphaCandidate('INFY'),
      makeAlphaCandidate('TCS'),
    ];

    const result = await coordinator.evaluate(candidates);

    // All same mergedScore (1.0), same plugin → sort by exchange then symbol
    expect(result.candidates[0].candidate.exchange).toBe('BSE');
    expect(result.candidates[0].candidate.tradingsymbol).toBe('TCS');
    expect(result.candidates[1].candidate.tradingsymbol).toBe('INFY');
    expect(result.candidates[2].candidate.tradingsymbol).toBe('TCS');
    expect(result.candidates[3].candidate.tradingsymbol).toBe('ZOMATO');
  });

  it('preserves each plugin score evidence with identity and rationale', async () => {
    const plugin = makePlugin(
      'momentum-v1', 'Momentum', '1.0.0',
      c => c.tradingsymbol === 'TCS' ? 0.9 : 0.3,
      c => `Momentum score for ${c.tradingsymbol}`,
    );
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates);

    expect(result.candidates[0].pluginScores).toHaveLength(1);
    expect(result.candidates[0].pluginScores[0].plugin.id).toBe('momentum-v1');
    expect(result.candidates[0].pluginScores[0].score).toBe(0.9);
    expect(result.candidates[0].pluginScores[0].rationale).toBe('Momentum score for TCS');
  });
});

// ---------------------------------------------------------------------------
// StrategyCoordinator — with async (LLM) plugin
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — with async LLM plugin', () => {
  it('includes LLM evidence in merged score when LLM is consulted', async () => {
    const detPlugin = makePlugin('det-v1', 'Deterministic', '1.0.0', () => 0.6);
    const llmPlugin = makeAsyncPlugin(
      'llm-ranking-v1', 'LLM Ranking', '1.0.0',
      () => 0.5,
      {
        rankings: [
          { candidate: makeAlphaCandidate('TCS'), plugin: { id: 'llm-ranking-v1', name: 'LLM Ranking', version: '1.0.0' }, score: 0.8, rationale: 'LLM pick' },
        ],
        llmStatus: LLMStatus.Consulted,
        llmScore: 0.8,
        llmRationale: 'LLM ranked 1 of 1 candidates',
      },
    );
    const coordinator = new StrategyCoordinator([detPlugin, llmPlugin], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates);

    expect(result.candidates).toHaveLength(1);
    // deterministicScore = 0.6 (from det-v1 only, llm scores aren't counted in deterministic)
    expect(result.candidates[0].deterministicScore).toBe(0.6);
    // llmScore = 0.8
    expect(result.candidates[0].llmScore).toBe(0.8);
    expect(result.candidates[0].llmStatus).toBe(LLMStatus.Consulted);
    // mergedScore = (0.6 + 0.8) / 2 = 0.7 (Average merge)
    expect(result.candidates[0].mergedScore).toBeCloseTo(0.7, 5);
    expect(result.candidates[0].mergePolicy).toBe(MergePolicy.Average);
  });

  it('uses DeterministicOnly merge when LLM returns Error status', async () => {
    const detPlugin = makePlugin('det-v1', 'Deterministic', '1.0.0', () => 0.6);
    const llmPlugin = makeAsyncPlugin(
      'llm-ranking-v1', 'LLM Ranking', '1.0.0',
      () => 0.5,
      {
        rankings: [
          { candidate: makeAlphaCandidate('TCS'), plugin: { id: 'llm-ranking-v1', name: 'LLM Ranking', version: '1.0.0' }, score: 0.5, rationale: 'Fallback' },
        ],
        llmStatus: LLMStatus.Error,
        llmScore: null,
        llmRationale: 'LLM provider error: timeout',
      },
    );
    const coordinator = new StrategyCoordinator([detPlugin, llmPlugin], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].llmStatus).toBe(LLMStatus.Error);
    expect(result.candidates[0].llmScore).toBeNull();
    // mergedScore = deterministicScore = 0.6
    expect(result.candidates[0].mergedScore).toBe(0.6);
    expect(result.candidates[0].mergePolicy).toBe(MergePolicy.DeterministicOnly);
  });

  it('uses DeterministicOnly merge when LLM returns Degraded status', async () => {
    const detPlugin = makePlugin('det-v1', 'Deterministic', '1.0.0', () => 0.6);
    const llmPlugin = makeAsyncPlugin(
      'llm-ranking-v1', 'LLM Ranking', '1.0.0',
      () => 0.5,
      {
        rankings: [],
        llmStatus: LLMStatus.Degraded,
        llmScore: null,
        llmRationale: 'LLM returned empty rankings',
      },
    );
    const coordinator = new StrategyCoordinator([detPlugin, llmPlugin], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].llmStatus).toBe(LLMStatus.Degraded);
    expect(result.candidates[0].llmScore).toBeNull();
    expect(result.candidates[0].mergedScore).toBe(0.6);
    expect(result.candidates[0].mergePolicy).toBe(MergePolicy.DeterministicOnly);
  });

  it('includes LLM plugin score evidence alongside deterministic scores', async () => {
    const detPlugin = makePlugin('det-v1', 'Deterministic', '1.0.0', () => 0.6);
    const llmPlugin = makeAsyncPlugin(
      'llm-ranking-v1', 'LLM Ranking', '1.0.0',
      () => 0.5,
      {
        rankings: [
          { candidate: makeAlphaCandidate('TCS'), plugin: { id: 'llm-ranking-v1', name: 'LLM Ranking', version: '1.0.0' }, score: 0.8, rationale: 'LLM pick' },
        ],
        llmStatus: LLMStatus.Consulted,
        llmScore: 0.8,
        llmRationale: 'LLM ranked 1 of 1',
      },
    );
    const coordinator = new StrategyCoordinator([detPlugin, llmPlugin], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates);

    // pluginScores should include both deterministic and LLM evidence
    expect(result.candidates[0].pluginScores).toHaveLength(2);
    const detScore = result.candidates[0].pluginScores.find(p => p.plugin.id === 'det-v1')!;
    expect(detScore.score).toBe(0.6);
    const llmScore = result.candidates[0].pluginScores.find(p => p.plugin.id === 'llm-ranking-v1')!;
    expect(llmScore.score).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// StrategyCoordinator — bounds enforcement
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — bounds enforcement', () => {
  it('respects maxCandidates limit', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0', () => 0.5);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 3 });

    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeAlphaCandidate(`SYM${i}`),
    );

    const result = await coordinator.evaluate(candidates);
    expect(result.candidates).toHaveLength(3);
  });

  it('returns all candidates when count is below maxCandidates', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0', () => 0.5);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 10 });

    const candidates = Array.from({ length: 4 }, (_, i) =>
      makeAlphaCandidate(`SYM${i}`),
    );

    const result = await coordinator.evaluate(candidates);
    expect(result.candidates).toHaveLength(4);
  });

  it('defaults to DEFAULT_FRAMEWORK_CONFIG.maxCandidates when no config given', () => {
    const coordinator = new StrategyCoordinator([]);
    expect(coordinator.config.maxCandidates).toBe(DEFAULT_FRAMEWORK_CONFIG.maxCandidates);
  });

  it('merges partial config with defaults', () => {
    const coordinator = new StrategyCoordinator([], { maxCandidates: 10 });
    expect(coordinator.config.maxCandidates).toBe(10);
    expect(coordinator.config.parallelPlugins).toBe(DEFAULT_FRAMEWORK_CONFIG.parallelPlugins);
  });
});

// ---------------------------------------------------------------------------
// StrategyCoordinator — India research evidence threading
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — India research evidence threading', () => {
  it('attaches India research evidence to HybridCandidateEvidence when provided', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0', () => 0.5);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const researchEvidence = new Map<string, import('../src/types/runtime.js').IndiaResearchCandidateEvidence>();
    researchEvidence.set('NSE:TCS', {
      summary: 'India equity listed on NSE | last @ INR 2500.50 | moderate liquidity | tight spread',
      tags: ['type:eq', 'liquidity:moderate', 'spread:tight'],
      freshnessMs: null,
      influenceScore: 0.9,
    });

    const result = await coordinator.evaluate(candidates, researchEvidence);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].indiaResearchEvidence).not.toBeNull();
    expect(result.candidates[0].indiaResearchEvidence!.summary).toContain('India equity');
    expect(result.candidates[0].indiaResearchEvidence!.tags).toContain('type:eq');
    expect(result.candidates[0].indiaResearchEvidence!.influenceScore).toBe(0.9);
  });

  it('sets indiaResearchEvidence to null when no research evidence is provided', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0', () => 0.5);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates); // No research evidence

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].indiaResearchEvidence).toBeNull();
  });

  it('sets indiaResearchEvidence to null for candidates not in the research map', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0', () => 0.5);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 5 });

    const candidates = [
      makeAlphaCandidate('TCS'),
      makeAlphaCandidate('INFY'),
    ];

    // Only provide evidence for TCS
    const researchEvidence = new Map();
    researchEvidence.set('NSE:TCS', {
      summary: 'India equity',
      tags: ['type:eq'],
      freshnessMs: null,
      influenceScore: 0.8,
    });

    const result = await coordinator.evaluate(candidates, researchEvidence);

    expect(result.candidates).toHaveLength(2);
    // INFY is first alphabetically, TCS is second
    expect(result.candidates[0].candidate.tradingsymbol).toBe('INFY');
    expect(result.candidates[0].indiaResearchEvidence).toBeNull(); // INFY doesn't have evidence
    expect(result.candidates[1].candidate.tradingsymbol).toBe('TCS');
    expect(result.candidates[1].indiaResearchEvidence).not.toBeNull(); // TCS has evidence
  });

  it('research evidence survives through multi-plugin evaluation', async () => {
    const pluginA = makePlugin('a-v1', 'A', '1.0.0', () => 0.6);
    const pluginB = makePlugin('b-v1', 'B', '1.0.0', () => 0.9);
    const coordinator = new StrategyCoordinator([pluginA, pluginB], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const researchEvidence = new Map();
    researchEvidence.set('NSE:TCS', {
      summary: 'India equity with strong fundamentals',
      tags: ['type:eq', 'liquidity:high'],
      freshnessMs: null,
      influenceScore: 0.95,
    });

    const result = await coordinator.evaluate(candidates, researchEvidence);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].indiaResearchEvidence).not.toBeNull();
    expect(result.candidates[0].indiaResearchEvidence!.influenceScore).toBe(0.95);
    expect(result.candidates[0].pluginScores).toHaveLength(2); // Both plugins contributed
  });

  it('research evidence does not affect merged score computation', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0', () => 0.5);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const researchEvidence = new Map();
    researchEvidence.set('NSE:TCS', {
      summary: 'Some research',
      tags: ['type:eq'],
      freshnessMs: null,
      influenceScore: 0.9,
    });

    // With research evidence
    const resultWith = await coordinator.evaluate(candidates, researchEvidence);
    // Without
    const resultWithout = await coordinator.evaluate(candidates);

    expect(resultWith.candidates[0].mergedScore).toBe(resultWithout.candidates[0].mergedScore);
    expect(resultWith.candidates[0].deterministicScore).toBe(resultWithout.candidates[0].deterministicScore);
  });
});

// ---------------------------------------------------------------------------
// StrategyCoordinator — empty and refusal behavior
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — empty / refusal', () => {
  it('returns empty result when no plugins are registered', async () => {
    const coordinator = new StrategyCoordinator([]);
    const candidates = [makeCandidate()];

    const result = await coordinator.evaluate(candidates);
    expect(result.candidates).toEqual([]);
    expect(result.plugins).toEqual([]);
    expect(result.totalEvaluated).toBe(0);
    expect(result.hasPluginErrors).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns empty candidate list when plugins return nothing', async () => {
    const emptyPlugin: StrategyPlugin = {
      identity: { id: 'empty-v1', name: 'Empty', version: '1.0.0' },
      evaluate: () => [],
    };
    const coordinator = new StrategyCoordinator([emptyPlugin]);

    const candidates = [makeCandidate()];
    const result = await coordinator.evaluate(candidates);
    expect(result.candidates).toEqual([]);
    expect(result.totalEvaluated).toBe(1);
    expect(result.hasPluginErrors).toBe(false);
  });

  it('returns empty candidate list when candidates array is empty', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0');
    const coordinator = new StrategyCoordinator([plugin]);

    const result = await coordinator.evaluate([]);
    expect(result.candidates).toEqual([]);
    expect(result.totalEvaluated).toBe(0);
    expect(result.hasPluginErrors).toBe(false);
  });

  it('aggregates plugin errors without crashing', async () => {
    const badPlugin: StrategyPlugin = {
      identity: { id: 'bad-v1', name: 'Bad Plugin', version: '1.0.0' },
      evaluate: () => {
        throw new Error('Something went wrong');
      },
    };
    const goodPlugin = makePlugin('good-v1', 'Good Plugin', '1.0.0', () => 0.5);
    const coordinator = new StrategyCoordinator([badPlugin, goodPlugin]);

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates);

    expect(result.hasPluginErrors).toBe(true);
    expect(result.pluginErrors['bad-v1']).toBe('Something went wrong');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].pluginScores[0].plugin.id).toBe('good-v1');
  });

  it('aggregates synchronous plugin errors', async () => {
    const syncErrorPlugin: StrategyPlugin = {
      identity: { id: 'sync-bad', name: 'Sync Error', version: '1.0.0' },
      evaluate: () => { throw new Error('Sync failure'); },
    };
    const coordinator = new StrategyCoordinator([syncErrorPlugin]);

    const candidates = [makeCandidate()];
    const result = await coordinator.evaluate(candidates);

    expect(result.hasPluginErrors).toBe(true);
    expect(result.pluginErrors['sync-bad']).toBe('Sync failure');
    expect(result.candidates).toEqual([]);
  });

  it('non-error plugin still contributes when another plugin fails', async () => {
    const badPlugin: StrategyPlugin = {
      identity: { id: 'bad-v1', name: 'Bad', version: '1.0.0' },
      evaluate: () => { throw new Error('fail'); },
    };
    const goodPlugin = makePlugin(
      'good-v1', 'Good', '1.0.0',
      () => 0.9,
      () => 'High score',
    );
    const coordinator = new StrategyCoordinator([badPlugin, goodPlugin]);

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates);

    expect(result.hasPluginErrors).toBe(true);
    expect(result.pluginErrors['bad-v1']).toBe('fail');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].pluginScores[0].plugin.id).toBe('good-v1');
    expect(result.candidates[0].pluginScores[0].score).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// StrategyCoordinator — metadata and diagnostics
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — metadata', () => {
  it('reports participating plugin identities', async () => {
    const pluginA = makePlugin('a-v1', 'Plugin A', '1.0.0');
    const pluginB = makePlugin('b-v1', 'Plugin B', '2.0.0');
    const coordinator = new StrategyCoordinator([pluginA, pluginB]);

    const result = await coordinator.evaluate([makeCandidate()]);
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[0].id).toBe('a-v1');
    expect(result.plugins[1].id).toBe('b-v1');
  });

  it('reports totalEvaluated count', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0');
    const coordinator = new StrategyCoordinator([plugin]);

    const candidates = [makeCandidate(), makeCandidate()];
    const result = await coordinator.evaluate(candidates);
    expect(result.totalEvaluated).toBe(2);
  });

  it('reports durationMs', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0');
    const coordinator = new StrategyCoordinator([plugin]);

    const result = await coordinator.evaluate([makeCandidate()]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('plugin identity list is an immutable copy', () => {
    const plugin = makePlugin('p-v1', 'P', '1.0.0');
    const coordinator = new StrategyCoordinator([plugin]);

    const plugins = coordinator.plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe('p-v1');

    // Mutating the returned copy should not affect internal state
    plugins[0] = { id: 'hacked', name: 'Hacked', version: '0.0.0' };
    expect(coordinator.plugins[0].id).toBe('p-v1');
  });
});

// ---------------------------------------------------------------------------
// StrategyCoordinator — multi-plugin interaction
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — multi-plugin', () => {
  it('aggregates ranked candidates from multiple plugins into grouped evidence', async () => {
    const pluginA = makePlugin(
      'a-v1', 'A', '1.0.0',
      c => (c.tradingsymbol === 'TCS' ? 0.9 : 0.1),
    );
    const pluginB = makePlugin(
      'b-v1', 'B', '1.0.0',
      c => (c.tradingsymbol === 'INFY' ? 0.8 : 0.2),
    );
    const coordinator = new StrategyCoordinator([pluginA, pluginB], { maxCandidates: 10 });

    const candidates = [
      makeAlphaCandidate('TCS'),
      makeAlphaCandidate('INFY'),
      makeAlphaCandidate('RELIANCE'),
    ];

    const result = await coordinator.evaluate(candidates);

    // 3 candidates, 2 plugins → 3 grouped evidence records (one per candidate)
    expect(result.candidates).toHaveLength(3);

    // TCS: A=0.9, B=0.2 → det=0.55
    const tcs = result.candidates.find(c => c.candidate.tradingsymbol === 'TCS')!;
    expect(tcs.deterministicScore).toBeCloseTo(0.55, 5);
    expect(tcs.pluginScores).toHaveLength(2);

    // INFY: A=0.1, B=0.8 → det=0.45
    const infy = result.candidates.find(c => c.candidate.tradingsymbol === 'INFY')!;
    expect(infy.deterministicScore).toBeCloseTo(0.45, 5);
    expect(infy.pluginScores).toHaveLength(2);

    // RELIANCE: A=0.1, B=0.2 → det=0.15
    const rel = result.candidates.find(c => c.candidate.tradingsymbol === 'RELIANCE')!;
    expect(rel.deterministicScore).toBeCloseTo(0.15, 5);
    expect(rel.pluginScores).toHaveLength(2);
  });

  it('capped at maxCandidates across all grouped evidence', async () => {
    const pluginA = makePlugin('a-v1', 'A', '1.0.0', () => 0.8);
    const pluginB = makePlugin('b-v1', 'B', '1.0.0', () => 0.9);
    const coordinator = new StrategyCoordinator([pluginA, pluginB], { maxCandidates: 1 });

    const candidates = [
      makeAlphaCandidate('TCS'),
      makeAlphaCandidate('INFY'),
    ];

    const result = await coordinator.evaluate(candidates);

    // 2 candidates, 2 plugins → 2 grouped evidence records, capped to 1
    expect(result.candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// StrategyCoordinator — config accessors
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — config', () => {
  it('returns default config when no config provided', () => {
    const coordinator = new StrategyCoordinator([]);
    expect(coordinator.config).toEqual(DEFAULT_FRAMEWORK_CONFIG);
    expect(coordinator.config.parallelPlugins).toBe(true);
    expect(coordinator.config.maxCandidates).toBe(5);
  });

  it('returns empty plugin list when no plugins', () => {
    const coordinator = new StrategyCoordinator([]);
    expect(coordinator.plugins).toEqual([]);
  });

  it('returns plugin identities from registered plugins', () => {
    const p1 = makePlugin('p1', 'P1', '1.0.0');
    const p2 = makePlugin('p2', 'P2', '2.0.0');
    const coordinator = new StrategyCoordinator([p1, p2]);

    const identities = coordinator.plugins;
    expect(identities).toHaveLength(2);
    expect(identities[0].id).toBe('p1');
    expect(identities[1].id).toBe('p2');
  });

  it('config is immutable copy', () => {
    const coordinator = new StrategyCoordinator([], { maxCandidates: 3 });
    const config = coordinator.config;
    expect(config.maxCandidates).toBe(3);

    // Mutate the returned copy
    (config as StrategyFrameworkConfig).maxCandidates = 99;
    expect(coordinator.config.maxCandidates).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// StrategyCoordinator — evaluateLegacy backward compat
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — evaluateLegacy backward compat', () => {
  it('returns flat ranked candidates from hybrid result', async () => {
    const pluginA = makePlugin('a-v1', 'A', '1.0.0', () => 0.6);
    const pluginB = makePlugin('b-v1', 'B', '1.0.0', () => 0.9);
    const coordinator = new StrategyCoordinator([pluginA, pluginB], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluateLegacy(candidates);

    // Should be CoordinatorResult (old shape)
    expect(result.candidates).toHaveLength(2); // 2 plugin scores → 2 flat candidates
    expect(result.candidates[0].plugin.id).toBe('a-v1');
    expect(result.candidates[1].plugin.id).toBe('b-v1');
    expect(result.plugins).toHaveLength(2);
    expect(result.totalEvaluated).toBe(1);
  });

  it('returns empty result with no plugins', async () => {
    const coordinator = new StrategyCoordinator([]);
    const result = await coordinator.evaluateLegacy([makeCandidate()]);

    expect(result.candidates).toEqual([]);
    expect(result.plugins).toEqual([]);
    expect(result.totalEvaluated).toBe(0);
  });
});
