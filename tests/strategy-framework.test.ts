import { describe, it, expect } from 'vitest';
import {
  type BoundedCandidate,
  type RankedCandidate,
  type StrategyPlugin,
  type StrategyPluginIdentity,
  type StrategyFrameworkConfig,
  type CoordinatorResult,
} from '../src/types/runtime.js';
import {
  StrategyCoordinator,
  DEFAULT_FRAMEWORK_CONFIG,
} from '../src/strategy/framework.js';

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
// StrategyCoordinator — deterministic ordering
// ---------------------------------------------------------------------------

describe('StrategyCoordinator — ordering', () => {
  it('orders by score descending', async () => {
    const highScorer = makePlugin(
      'high-v1', 'High Scorer', '1.0.0',
      c => (c.tradingsymbol === 'TCS' ? 0.9 : 0.1),
    );
    const coordinator = new StrategyCoordinator([highScorer], { maxCandidates: 5 });
    const candidates = [
      makeAlphaCandidate('RELIANCE'),
      makeAlphaCandidate('TCS'),
    ];

    const result = await coordinator.evaluate(candidates);
    expect(result.candidates[0].candidate.tradingsymbol).toBe('TCS');
    expect(result.candidates[1].candidate.tradingsymbol).toBe('RELIANCE');
  });

  it('breaks ties by plugin insertion order', async () => {
    const pluginA = makePlugin('a-v1', 'A', '1.0.0', () => 1.0);
    const pluginB = makePlugin('b-v1', 'B', '1.0.0', () => 1.0);
    const coordinator = new StrategyCoordinator([pluginA, pluginB], { maxCandidates: 5 });

    const candidates = [makeAlphaCandidate('TCS')];
    const result = await coordinator.evaluate(candidates);

    // Same candidate from both plugins — A first in insertion order
    expect(result.candidates[0].plugin.id).toBe('a-v1');
    expect(result.candidates[1].plugin.id).toBe('b-v1');
  });

  it('breaks ties by exchange then tradingsymbol alphabetically', async () => {
    const plugin = makePlugin('test-v1', 'Test', '1.0.0', () => 1.0);
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 10 });

    const candidates = [
      makeAlphaCandidate('ZOMATO'),
      makeAlphaCandidate('TCS', { exchange: 'BSE' }),
      makeAlphaCandidate('INFY'),
      makeAlphaCandidate('TCS'),
    ];

    const result = await coordinator.evaluate(candidates);

    // All same score (1.0), same plugin — sort by exchange then symbol
    // BSE TCS, NSE INFY, NSE TCS, NSE ZOMATO
    expect(result.candidates[0].candidate.exchange).toBe('BSE');
    expect(result.candidates[0].candidate.tradingsymbol).toBe('TCS');
    expect(result.candidates[1].candidate.exchange).toBe('NSE');
    expect(result.candidates[1].candidate.tradingsymbol).toBe('INFY');
    expect(result.candidates[2].candidate.tradingsymbol).toBe('TCS');
    expect(result.candidates[3].candidate.tradingsymbol).toBe('ZOMATO');
  });

  it('produces deterministic order given same inputs', async () => {
    const plugin = makePlugin('det-v1', 'Deterministic', '1.0.0', c =>
      c.tradingsymbol === 'AAPL' ? 0.8 : 0.5,
    );
    const coordinator = new StrategyCoordinator([plugin], { maxCandidates: 5 });
    const candidates = [
      makeAlphaCandidate('INFY'),
      makeAlphaCandidate('TCS'),
      makeAlphaCandidate('RELIANCE'),
      makeAlphaCandidate('HDFC'),
      makeAlphaCandidate('AAPL'),
    ];

    const result1 = await coordinator.evaluate(candidates);
    const result2 = await coordinator.evaluate(candidates);

    // Same length
    expect(result1.candidates).toHaveLength(result2.candidates.length);
    // Same order
    for (let i = 0; i < result1.candidates.length; i++) {
      expect(result1.candidates[i].candidate.tradingsymbol)
        .toBe(result2.candidates[i].candidate.tradingsymbol);
      expect(result1.candidates[i].score)
        .toBe(result2.candidates[i].score);
    }
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
    expect(result.candidates[0].plugin.id).toBe('good-v1');
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
    expect(result.candidates[0].plugin.id).toBe('good-v1');
    expect(result.candidates[0].score).toBe(0.9);
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
  it('aggregates ranked candidates from multiple plugins', async () => {
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

    // Each plugin produces result for each candidate → 6 total
    // Score ordering: TCS (A:0.9) > INFY (B:0.8) > RELIANCE (A:0.1) > INFY (A:0.1) > RELIANCE (B:0.2) > TCS (B:0.1)... no wait
    // A: TCS=0.9, INFY=0.1, RELIANCE=0.1
    // B: TCS=0.2, INFY=0.8, RELIANCE=0.2
    // Sorted: TCS/A(0.9), INFY/B(0.8), TCS/B(0.2), INFY/A(0.1), RELIANCE/A(0.1), RELIANCE/B(0.2)
    // Wait, 0.2 > 0.1 so: TCS/A(0.9), INFY/B(0.8), TCS/B(0.2), RELIANCE/B(0.2), INFY/A(0.1), RELIANCE/A(0.1)
    // TCS/B(0.2) and RELIANCE/B(0.2): same plugin, score → exchange (both NSE) → symbol alphabetical: RELIANCE < TCS
    // Actually: RELIANCE < TCS alphabetically. So: TCS/B(0.2) first, then RELIANCE/B(0.2)? No, RELIANCE < TCS so RELIANCE comes first.
    // But B scored both at 0.2. So within same plugin + score: sort by exchange then symbol.
    // Both NSE. RELIANCE (R) vs TCS (T): R < T. So RELIANCE/B(0.2) before TCS/B(0.2).
    // So: TCS/A(0.9), INFY/B(0.8), RELIANCE/B(0.2), TCS/B(0.2), INFY/A(0.1), RELIANCE/A(0.1)
    expect(result.candidates).toHaveLength(6);
    expect(result.candidates[0].candidate.tradingsymbol).toBe('TCS');
    expect(result.candidates[0].plugin.id).toBe('a-v1');
    expect(result.candidates[0].score).toBe(0.9);

    expect(result.candidates[1].candidate.tradingsymbol).toBe('INFY');
    expect(result.candidates[1].plugin.id).toBe('b-v1');
    expect(result.candidates[1].score).toBe(0.8);
  });

  it('capped at maxCandidates across all plugins', async () => {
    const pluginA = makePlugin('a-v1', 'A', '1.0.0', () => 0.8);
    const pluginB = makePlugin('b-v1', 'B', '1.0.0', () => 0.9);
    const coordinator = new StrategyCoordinator([pluginA, pluginB], { maxCandidates: 2 });

    const candidates = [
      makeAlphaCandidate('TCS'),
      makeAlphaCandidate('INFY'),
    ];

    const result = await coordinator.evaluate(candidates);

    // 4 total (2 plugins × 2 candidates), capped to 2
    // B scores higher (0.9) so B's candidates come first
    // Within B: B/INFY(0.9), B/TCS(0.9) — tie → plugin same → exchange both NSE → symbol alphabetical: INFY, TCS
    // So: B/INFY(0.9), B/TCS(0.9) — capped at 2
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].plugin.id).toBe('b-v1');
    expect(result.candidates[1].plugin.id).toBe('b-v1');
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
