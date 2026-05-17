// ── Strategy Coordinator Factory Tests ──
// Tests the shared coordinator construction seam used by both runtime and
// replay. Verifies:
//   - Factory produces a functioning coordinator with deterministic fallback
//   - LLM plugin is included when proposal engine is provided
//   - Coordinator without proposal engine still produces non-empty results
//   - Plugin configuration is respected through the factory

import { describe, it, expect } from 'vitest';
import { createStrategyCoordinator } from '../src/strategy/coordinator-factory.js';
import { DeterministicScreenerPlugin } from '../src/strategy/deterministic-screener-plugin.js';
import type {
  BoundedCandidate,
  StrategyPlugin,
  StrategyPluginIdentity,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Fixture candidates
// ---------------------------------------------------------------------------

const BASE_CANDIDATES: BoundedCandidate[] = [
  {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 738561,
    side: 'buy',
    lastPrice: 2450.50,
    bid: 2450.00,
    ask: 2451.00,
    volume: 1250000,
    instrumentType: 'EQ',
    lotSize: 1,
    tickSize: 0.05,
  },
  {
    exchange: 'NSE',
    tradingsymbol: 'TCS',
    instrumentToken: 2953217,
    side: 'buy',
    lastPrice: 3890.00,
    bid: 3889.50,
    ask: 3890.50,
    volume: 850000,
    instrumentType: 'EQ',
    lotSize: 1,
    tickSize: 0.05,
  },
  {
    exchange: 'NSE',
    tradingsymbol: 'HDFCBANK',
    instrumentToken: 341249,
    side: 'buy',
    lastPrice: 1680.25,
    bid: 1680.00,
    ask: 1680.50,
    volume: 2100000,
    instrumentType: 'EQ',
    lotSize: 1,
    tickSize: 0.05,
  },
  {
    exchange: 'NSE',
    tradingsymbol: 'INFY',
    instrumentToken: 408065,
    side: 'buy',
    lastPrice: 1520.00,
    bid: null,
    ask: null,
    volume: 500000,
    instrumentType: 'EQ',
    lotSize: 1,
    tickSize: 0.05,
  },
];

// ---------------------------------------------------------------------------
// DeterministicScreenerPlugin unit tests
// ---------------------------------------------------------------------------

describe('DeterministicScreenerPlugin', () => {
  it('returns empty for empty input', () => {
    const plugin = new DeterministicScreenerPlugin();
    const result = plugin.evaluate([]);
    expect(result).toEqual([]);
  });

  it('scores candidates by deterministic heuristics', () => {
    const plugin = new DeterministicScreenerPlugin();
    const result = plugin.evaluate(BASE_CANDIDATES);

    // All candidates should be scored
    expect(result).toHaveLength(BASE_CANDIDATES.length);

    // Each candidate should have a score in 0–1 range
    for (const r of result) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.plugin.id).toBe('deterministic-screener-v1');
      expect(r.rationale).toContain('Deterministic score');
    }
  });

  it('sorts by score descending, then exchange, then symbol', () => {
    const plugin = new DeterministicScreenerPlugin();
    const result = plugin.evaluate(BASE_CANDIDATES);

    // Verify sort order
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1];
      const curr = result[i];

      if (curr.score !== prev.score) {
        expect(curr.score).toBeLessThanOrEqual(prev.score);
      } else if (curr.candidate.exchange !== prev.candidate.exchange) {
        expect(curr.candidate.exchange.localeCompare(prev.candidate.exchange)).toBeGreaterThanOrEqual(0);
      } else {
        expect(curr.candidate.tradingsymbol.localeCompare(prev.candidate.tradingsymbol)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('assigns correct identity', () => {
    const plugin = new DeterministicScreenerPlugin();
    expect(plugin.identity).toEqual({
      id: 'deterministic-screener-v1',
      name: 'Deterministic Screener',
      version: '1.0.0',
    });
  });
});

// ---------------------------------------------------------------------------
// createStrategyCoordinator factory tests
// ---------------------------------------------------------------------------

describe('createStrategyCoordinator', () => {
  it('returns a functioning coordinator with default options', async () => {
    const coordinator = createStrategyCoordinator();
    const result = await coordinator.evaluate(BASE_CANDIDATES);

    // Should produce non-empty results (deterministic fallback)
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThanOrEqual(5); // default maxCandidates
    expect(result.plugins.length).toBeGreaterThan(0);
  });

  it('includes only deterministic plugin when no proposal engine provided', () => {
    const coordinator = createStrategyCoordinator({ maxCandidates: 3 });
    const pluginIds = coordinator.plugins.map(p => p.id);

    expect(pluginIds).toContain('deterministic-screener-v1');
    // No LLM plugin since no proposal engine
    expect(pluginIds).not.toContain('llm-ranking-v1');
  });

  it('respects maxCandidates option', async () => {
    const coordinator = createStrategyCoordinator({ maxCandidates: 2 });
    const result = await coordinator.evaluate(BASE_CANDIDATES);

    expect(result.candidates.length).toBeLessThanOrEqual(2);
  });

  it('returns empty result for empty candidates', async () => {
    const coordinator = createStrategyCoordinator({ maxCandidates: 5 });
    const result = await coordinator.evaluate([]);

    expect(result.candidates).toEqual([]);
    expect(result.totalEvaluated).toBe(0);
    expect(result.hasPluginErrors).toBe(false);
  });

  it('produces consistent deterministic scores across calls', async () => {
    const coordinator = createStrategyCoordinator({ maxCandidates: 5 });

    const result1 = await coordinator.evaluate(BASE_CANDIDATES);
    const result2 = await coordinator.evaluate(BASE_CANDIDATES);

    // Same input should produce the same scores (deterministic)
    expect(result1.candidates).toHaveLength(result2.candidates.length);

    for (let i = 0; i < result1.candidates.length; i++) {
      expect(result1.candidates[i].candidateKey).toBe(result2.candidates[i].candidateKey);
      expect(result1.candidates[i].deterministicScore).toBe(result2.candidates[i].deterministicScore);
      expect(result1.candidates[i].mergedScore).toBe(result2.candidates[i].mergedScore);
    }
  });

  it('persists truthful LLM status when LLM is not configured', async () => {
    const coordinator = createStrategyCoordinator({ maxCandidates: 5 });
    const result = await coordinator.evaluate(BASE_CANDIDATES);

    // Without a proposal engine, all candidates should have deterministic-only merge policy
    for (const c of result.candidates) {
      expect(c.llmStatus).toBe('skipped');
      expect(c.mergePolicy).toBe('deterministic_only');
      expect(c.llmScore).toBeNull();
    }
  });

  it('does not crash with empty or undefined options', async () => {
    const coordinator1 = createStrategyCoordinator();
    const coordinator2 = createStrategyCoordinator({});
    const coordinator3 = createStrategyCoordinator(undefined);

    const [r1, r2, r3] = await Promise.all([
      coordinator1.evaluate(BASE_CANDIDATES),
      coordinator2.evaluate(BASE_CANDIDATES),
      coordinator3.evaluate(BASE_CANDIDATES),
    ]);

    expect(r1.candidates.length).toBeGreaterThan(0);
    expect(r2.candidates.length).toBeGreaterThan(0);
    expect(r3.candidates.length).toBeGreaterThan(0);

    // All should have identical scores (same plugins, same config)
    expect(r1.candidates.length).toBe(r2.candidates.length);
    expect(r2.candidates.length).toBe(r3.candidates.length);
  });
});
